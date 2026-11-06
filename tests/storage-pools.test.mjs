import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadModule } from './load-module.mjs';

const poolsModule = await loadModule('../src/storage/pools.ts');
const { parseZfsPools } = poolsModule;
const output =
    'archpool\t2000\t1400\t600\t70\tONLINE\n' +
    'metalpool\t1000\t780\t220\t78\tDEGRADED\n';

test('parses exact pool allocation independently of mounted dataset capacity', () => {
    const pools = parseZfsPools(output);
    assert.deepEqual(Array.from(pools, p => [p.name, p.size, p.allocated, p.free, p.capacity, p.health]), [
        ['archpool', 2000, 1400, 600, 70, 'ONLINE'],
        ['metalpool', 1000, 780, 220, 78, 'DEGRADED'],
    ]);
    assert.equal(parseZfsPools('empty\t100\t0\t100\t0\tONLINE')[0].capacity, 0);
    assert.equal(parseZfsPools('full\t100\t100\t0\t100\tONLINE')[0].free, 0);
});

test('omits unavailable and malformed capacity instead of displaying misleading bars', () => {
    const invalid = [
        '', 'no pools available', 'bad\t-\t-\t-\t-\tUNAVAIL',
        'bad\t100\t-1\t101\t0\tONLINE', 'bad\t0\t0\t0\t0\tONLINE',
        'bad\t100\t80\t30\t80\tONLINE', 'bad\t100\t80\t20\t101\tONLINE',
        'bad\t100x\t80\t20\t80\tONLINE',
        'bad\t9007199254740993\t80\t20\t80\tONLINE',
    ];
    for(const line of invalid) assert.equal(parseZfsPools(line).length, 0, line);
});

async function platformModule(path, overrides = {}) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const mocks = Object.fromEntries(
        [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => [match[1], { default: class {} }])
    );
    mocks['../storage/pools.js'] = poolsModule;
    return loadModule(path, { ...mocks, ...overrides });
}

test('pool collection uses a read-only command and tolerates absent tools or command failure', async () => {
    let program = '/run/current-system/sw/bin/zpool';
    const { default: Utils } = await platformModule('../src/utils/utils.ts', {
        '../storage/filesystem.js': await loadModule('../src/storage/filesystem.ts'),
        'gi://GLib': { default: {
            find_program_in_path: () => program,
            shell_quote: value => `'${value}'`,
        } },
    });
    Utils.runAsyncCommand = async command => {
        assert.equal(command, "'/run/current-system/sw/bin/zpool' list -H -p -o name,size,alloc,free,capacity,health");
        return output;
    };
    assert.equal((await Utils.getZfsPoolsAsync()).length, 2);
    program = null;
    Utils.runAsyncCommand = async () => { throw new Error('must not execute'); };
    assert.equal((await Utils.getZfsPoolsAsync()).length, 0);
    program = '/bin/zpool';
    assert.equal((await Utils.getZfsPoolsAsync()).length, 0);
});

class Widget {
    constructor(props = {}) { Object.assign(this, props); }
    addToGrid() {}
    destroy() { this.destroyed = true; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    setUsage(usage) { this.usage = usage; }
}

test('Devices refresh renders both pools, updates allocation, and removes vanished pools', async () => {
    let pools = parseZfsPools(output);
    const utils = {
        getBlockDevicesAsync: async () => new Map(),
        getZfsPoolsAsync: async () => pools,
        formatBytes: value => `${value} B`,
    };
    const { default: StorageMenu } = await platformModule('../src/storage/storageMenu.ts', {
        '../utils/utils.js': { default: utils },
        '../config.js': { default: { get_json: () => [], get_string: () => '' } },
        '../grid.js': { default: Widget },
        './storageBars.js': { default: Widget },
        'gi://St': { default: { Label: Widget } },
        'resource:///org/gnome/shell/extensions/extension.js': {
            gettext: value => value, pgettext: (_context, value) => value,
        },
    });
    const menu = Object.create(StorageMenu.prototype);
    Object.assign(menu, {
        isOpen: true, deviceListGeneration: 0,
        poolSectionLabel: new Widget(), poolSection: new Widget(), pools: new Map(),
        noDevicesLabel: new Widget(), devices: new Map(),
    });
    await menu.updateDeviceList();
    assert.equal(menu.pools.size, 2);
    const row = menu.pools.get('metalpool');
    assert.equal(row.label.text, 'metalpool');
    assert.equal(row.health.text, 'DEGRADED');
    assert.equal(row.percentage.text, '78%');
    assert.match(row.detail.text, /780 B.*1000 B.*220 B/);
    assert.equal(row.bar.usage.usePercentage, 78);
    assert.equal(menu.poolSection.visible, true);
    pools = parseZfsPools('metalpool\t1000\t800\t200\t80\tONLINE');
    const removed = menu.pools.get('archpool');
    await menu.updateDeviceList();
    assert.equal(menu.pools.size, 1);
    assert.equal(removed.container.destroyed, true);
    assert.equal(row.percentage.text, '80%');
    assert.equal(row.health.text, 'ONLINE');
    pools = [];
    await menu.updateDeviceList();
    assert.equal(menu.pools.size, 0);
    assert.equal(menu.poolSection.visible, false);

    let finish;
    utils.getZfsPoolsAsync = () => new Promise(resolve => { finish = resolve; });
    const pending = menu.updateDeviceList();
    menu.isOpen = false;
    finish(parseZfsPools(output));
    await pending;
    assert.equal(menu.pools.size, 0, 'closed menu must not accept late samples');
    menu.isOpen = true;
    const older = menu.updateDeviceList();
    const finishOlder = finish;
    utils.getZfsPoolsAsync = async () => [];
    await menu.updateDeviceList();
    finishOlder(parseZfsPools(output));
    await older;
    assert.equal(menu.pools.size, 0, 'superseded refresh must not restore stale pools');
});
