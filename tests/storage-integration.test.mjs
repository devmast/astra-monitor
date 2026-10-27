import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadModule } from './load-module.mjs';

const filesystem = await loadModule('../src/storage/filesystem.ts');
const mountinfo = '30 1 0:42 / /home rw - zfs zpool/home rw\n';
const datasetId = filesystem.parseZfsMounts(mountinfo)[0].id;
async function platformModule(path, overrides) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const mocks = Object.fromEntries(
        [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => [
            match[1],
            { default: class {} },
        ])
    );
    mocks['./filesystem.js'] = filesystem;
    mocks['../storage/filesystem.js'] = filesystem;
    return loadModule(path, { ...mocks, ...overrides });
}
const { default: Utils } = await platformModule('../src/utils/utils.ts', {});
Utils.readFileAsync = async () => mountinfo;
Utils.error = () => {};

test('discovers ZFS even without lsblk and keeps existing disk IDs', async () => {
    Utils.getLsblkPathAsync = async () => false;
    let disks = await Utils.listDisksAsync();
    assert.ok(disks.has(datasetId));
    assert.equal(disks.get(datasetId).path, undefined);
    Utils.getLsblkPathAsync = async () => '';
    Utils.runAsyncCommand = async () =>
        JSON.stringify({
            blockdevices: [{ id: 'existing', name: 'sda1', path: '/dev/sda1', mountpoints: ['/'] }],
        });
    disks = await Utils.listDisksAsync();
    assert.ok(disks.has('existing'));
    assert.ok(disks.has(datasetId));
    assert.equal(Utils.findDefaultDisk(disks), 'existing');
    Utils.runAsyncCommand = async () => {
        throw new Error('lsblk failed');
    };
    assert.ok((await Utils.listDisksAsync()).has(datasetId));
});

let selected = datasetId;
const writes = [];
const Config = {
    get_string: () => selected,
    set: (...args) => writes.push(args),
};
const { default: StorageMonitor } = await platformModule('../src/storage/storageMonitor.ts', {
    '../utils/utils.js': { default: Utils },
    '../config.js': { default: Config },
    '../utils/promiseValueHolder.js': { default: class {}, PromiseValueHolderStore: class {} },
});
function monitor() {
    const instance = Object.create(StorageMonitor.prototype);
    instance.updateStorageUsageTask = { cancellable: { is_cancelled: () => false } };
    instance.samples = [];
    instance.pushUsageHistory = (_key, usage) => instance.samples.push(usage);
    instance.resetUsageHistory = () => {
        instance.cleared = true;
    };
    instance.setUsageValue = (_key, value) => {
        instance.value = value;
    };
    return instance;
}

test('keeps a missing dataset selection instead of saving the default', async () => {
    const instance = monitor();
    const disks = new Map([['root', { mountpoints: ['/'] }]]);
    assert.equal(await instance.checkMainDiskAsync(disks), datasetId);
    assert.equal(writes.length, 0);
});

test('all collector modes route ZFS to filesystem statistics without libgtop', async () => {
    const original = Utils.getFilesystemUsageAsync;
    Utils.getFilesystemUsageAsync = async id => {
        assert.equal(id, datasetId);
        return filesystem.filesystemUsage(733, 243, 490);
    };
    Utils.GTop = false;
    await Promise.all(
        ['Auto', 'Proc', 'GTop'].map(async mode => {
            const instance = monitor();
            assert.equal(await instance[`updateStorageUsage${mode}`](), true);
            assert.equal(instance.samples[0].usePercentage, 34);
        })
    );
    Utils.getFilesystemUsageAsync = original;
});

test('missing dataset clears current usage instead of retaining a stale sample', async () => {
    const original = Utils.getFilesystemUsageAsync;
    Utils.getFilesystemUsageAsync = async () => null;
    const instance = monitor();
    assert.equal(await instance.updateStorageUsageAuto(), false);
    assert.equal(instance.cleared, true);
    assert.equal(instance.value, null);
    Utils.getFilesystemUsageAsync = original;
});

test('conventional proc collection still queries a block path', async () => {
    selected = 'existing';
    Utils.getLsblkPathAsync = async () => '';
    const original = Utils.listDisksAsync;
    Utils.listDisksAsync = async () => new Map([['existing', { path: '/dev/sda1' }]]);
    Utils.runAsyncCommand = async command => {
        assert.match(command, /lsblk -Jb -o ID,SIZE,FSUSE% \/dev\/sda1/);
        return JSON.stringify({ blockdevices: [{ size: 100, 'fsuse%': '25%' }] });
    };
    const instance = monitor();
    assert.equal(await instance.updateStorageUsageProc(), true);
    assert.equal(instance.samples[0].used, 25);
    Utils.listDisksAsync = original;
    selected = datasetId;
});

test('GIO adapter requests independent size, used, available attributes and passes cancellation', async () => {
    const cancellation = {};
    let type = 'zfs';
    let missing = false;
    let fail = false;
    let observed;
    const info = {
        get_attribute_string: () => type,
        has_attribute: () => !missing,
        get_attribute_uint64: attribute =>
            ({
                'filesystem::size': 1000,
                'filesystem::used': 243,
                'filesystem::free': 490,
            })[attribute],
    };
    const file = {
        query_filesystem_info_async(attributes, priority, cancellable, callback) {
            observed = { attributes, priority, cancellable };
            callback(file, {});
        },
        query_filesystem_info_finish() {
            if(fail) throw new Error('unmounted');
            return info;
        },
    };
    const { default: Adapter } = await platformModule('../src/utils/utils.ts', {
        'gi://Gio': {
            default: {
                File: {
                    new_for_path: path => {
                        assert.equal(path, '/home');
                        return file;
                    },
                },
            },
        },
        'gi://GLib': { default: { PRIORITY_DEFAULT: 0 } },
    });
    Adapter.readFileAsync = async () => mountinfo;
    assert.equal(
        (await Adapter.getFilesystemUsageAsync(datasetId, cancellation)).usePercentage,
        34
    );
    assert.equal(observed.cancellable, cancellation);
    assert.match(observed.attributes, /filesystem::used/);
    type = 'ext4';
    assert.equal(await Adapter.getFilesystemUsageAsync(datasetId), null);
    type = 'zfs';
    missing = true;
    assert.equal(await Adapter.getFilesystemUsageAsync(datasetId), null);
    missing = false;
    fail = true;
    await assert.rejects(Adapter.getFilesystemUsageAsync(datasetId), /unmounted/);
});

test('cancelled or superseded samples do not overwrite the selected target', async () => {
    const original = Utils.getFilesystemUsageAsync;
    Utils.getFilesystemUsageAsync = async () => filesystem.filesystemUsage(733, 243, 490);
    const instance = monitor();
    instance.updateStorageUsageTask.cancellable.is_cancelled = () => true;
    assert.equal(await instance.updateStorageUsageAuto(), false);
    assert.equal(instance.samples.length, 0);
    instance.updateStorageUsageTask.cancellable.is_cancelled = () => false;
    Utils.getFilesystemUsageAsync = async () => {
        selected = 'existing';
        return filesystem.filesystemUsage(733, 243, 490);
    };
    assert.equal(await instance.updateStorageUsageAuto(), false);
    assert.equal(instance.samples.length, 0);
    selected = datasetId;
    Utils.getFilesystemUsageAsync = original;
});

test('preferences retain and label a missing saved dataset, then rediscover it', async () => {
    let choices;
    const widget = class {
        add() {}
    };
    const prefsUtils = new Proxy(
        {},
        {
            get: (_target, name) => {
                if(name === 'addDropRow')
                    return (_props, generate, key) => {
                        if(key === 'storage-main') choices = generate;
                    };
                return () => ({});
            },
        }
    );
    const original = Utils.listDisksAsync;
    Utils.listDisksAsync = async () => new Map();
    Utils.getBlockDevicesAsync = async () => new Map();
    const { default: StoragePrefs } = await platformModule('../src/prefs/storage.ts', {
        'gi://Adw': { default: { PreferencesPage: widget, PreferencesGroup: widget } },
        '../utils/utils.js': { default: Utils },
        '../config.js': { default: { ...Config, get_json: () => [], connect: () => {} } },
        './prefsUtils.js': { default: prefsUtils },
        'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js': {
            gettext: value => value,
        },
    });
    const instance = Object.create(StoragePrefs.prototype);
    instance.getGeneralPage();
    writes.length = 0;
    let entries = await choices();
    assert.equal(entries[0].value, datasetId);
    assert.match(entries[0].text, /Unavailable/);
    assert.equal(writes.length, 0);
    Utils.listDisksAsync = async () =>
        new Map([
            [
                datasetId,
                {
                    name: '',
                    label: 'ZFS: zpool/home (/home)',
                },
            ],
        ]);
    entries = await choices();
    assert.equal(entries[0].text, 'ZFS: zpool/home (/home)');
    assert.equal(entries[0].value, datasetId);
    Utils.listDisksAsync = original;
});

test('capacity indicators display valid zero values and clear missing samples', async () => {
    let usage = { size: 100, used: 0, free: 0, usePercentage: 0 };
    const { default: StorageHeader } = await platformModule('../src/storage/storageHeader.ts', {
        'gi://GObject': { default: { registerClass: value => value } },
        '../config.js': { default: { get_boolean: () => true, get_int: () => 2 } },
        '../utils/utils.js': {
            default: {
                storageMonitor: { getCurrentValue: () => usage },
                formatBytes: value => (value === 0 ? '- B' : `${value} B`),
            },
        },
    });
    const header = Object.create(StorageHeader.prototype);
    header.visible = true;
    header.percentage = {};
    header.value = {};
    header.free = {};
    header.updatePercentage();
    header.updateValue();
    header.updateFree();
    assert.equal(header.percentage.text, '0%');
    assert.equal(header.value.text, '0 B');
    assert.equal(header.free.text, '0 B');
    usage = null;
    header.updatePercentage();
    header.updateValue();
    header.updateFree();
    assert.equal(header.percentage.text, '');
    assert.equal(header.value.text, '-');
    assert.equal(header.free.text, '-');
});
