import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const { parseZfsMounts, filesystemUsage, isFilesystemId, sampleFilesystem } = await loadModule(
    '../src/storage/filesystem.ts'
);
const mount = (id = 30, source = 'zpool/home', target = '/home', root = '/', type = 'zfs') =>
    `${id} 1 0:42 ${root} ${target} rw shared:1 - ${type} ${source} rw\n`;
const home = () => parseZfsMounts(mount())[0];

test('discovers mounted dataset roots only, with stable distinct IDs', () => {
    const datasets = parseZfsMounts(
        mount() +
            mount(31, 'zpool/root', '/') +
            mount(32, 'zpool/home', '/alias') +
            mount(33, 'zpool/home', '/bind', '/subdir') +
            mount(34, '/dev/sda', '/boot', '/', 'ext4') +
            mount(35) +
            'malformed\n'
    );
    assert.equal(datasets.length, 3);
    assert.equal(datasets[0].source, 'zpool/home');
    assert.equal(datasets[0].mountpoint, '/home');
    assert.equal(datasets[0].id, home().id);
    assert.equal(new Set(datasets.map(d => d.id)).size, 3);
    assert.ok(isFilesystemId(datasets[0].id));
    assert.equal(isFilesystemId('nvme0n1p2'), false);
    assert.equal(parseZfsMounts('').length, 0);
});

test('decodes Linux mount escapes once and avoids identifier collisions', () => {
    const [dataset] = parseZfsMounts(mount(30, 'pool/a\\134040b', '/a\\040b\\011c\\012d\\134e'));
    assert.equal(dataset.source, 'pool/a\\040b');
    assert.equal(dataset.mountpoint, '/a b\tc\nd\\e');
    assert.notEqual(
        parseZfsMounts(mount(50, 'pool/a:/b', '/c'))[0].id,
        parseZfsMounts(mount(50, 'pool/a', '/b:/c'))[0].id
    );
});

test('hides a dataset covered by another filesystem at the same mountpoint', () => {
    assert.equal(parseZfsMounts(mount() + mount(40, 'tmpfs', '/home', '/', 'tmpfs')).length, 0);
});

test('uses actual used and caller-available space, with df percentage rounding', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(filesystemUsage(1000, 243, 490))), {
        size: 1000,
        used: 243,
        free: 490,
        usePercentage: 34,
    });
    assert.equal(filesystemUsage(100, 0, 90).usePercentage, 0);
    assert.equal(filesystemUsage(100, 90, 0).usePercentage, 100);
    for(const args of [
        [0, 0, 0],
        [100, -1, 2],
        [100, 101, 0],
        [100, 0, 101],
        [100, 90, 20],
        [NaN, 1, 1],
        [Infinity, 1, 1],
    ]) {
        assert.equal(filesystemUsage(...args), null);
    }
});

test('samples a current mount without assuming a device path', async () => {
    const result = await sampleFilesystem(
        home().id,
        async () => mount(),
        async dataset => {
            assert.equal(dataset.source, 'zpool/home');
            return filesystemUsage(733, 243, 490);
        }
    );
    assert.equal(result.used, 243);
});

test('does not query an absent dataset or accept a remount during collection', async () => {
    let queries = 0;
    assert.equal(
        await sampleFilesystem(
            home().id,
            async () => '',
            async () => {
                queries++;
            }
        ),
        null
    );
    assert.equal(queries, 0);
    let reads = 0;
    assert.equal(
        await sampleFilesystem(
            home().id,
            async () => mount(++reads === 1 ? 30 : 31),
            async () => filesystemUsage(733, 243, 490)
        ),
        null
    );
    reads = 0;
    assert.equal(
        await sampleFilesystem(
            home().id,
            async () => (++reads === 1 ? mount() : ''),
            async () => filesystemUsage(733, 243, 490)
        ),
        null
    );
});

test('excludes children hidden by a parent overmount, even when replacement is ZFS', async () => {
    const underlying = '10 1 0:10 / /tank rw - zfs pool/old rw\n';
    const child = '20 10 0:20 / /tank/data rw - zfs pool/data rw\n';
    const replacement = '30 1 0:30 / /tank rw - zfs pool/new rw\n';
    const text = underlying + child + replacement;
    const targets = parseZfsMounts(text);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].source, 'pool/new');
    let queried = false;
    const childId = parseZfsMounts(underlying + child).find(t => t.source === 'pool/data').id;
    assert.equal(
        await sampleFilesystem(
            childId,
            async () => text,
            async () => {
                queried = true;
                return filesystemUsage(100, 50, 50);
            }
        ),
        null
    );
    assert.equal(queried, false);
    const newChild = '40 30 0:40 / /tank/data rw - zfs pool/new-data rw\n';
    assert.equal(
        parseZfsMounts(text + newChild).find(t => t.mountpoint === '/tank/data').source,
        'pool/new-data'
    );
});

test('allows visible stacked mounts whose parent is the covered mount at the same path', () => {
    const text =
        '10 1 0:10 / /tank rw - zfs pool/old rw\n' +
        '30 10 0:30 / /tank rw - zfs pool/new rw\n' +
        '40 30 0:40 / /tank/data rw - zfs pool/data rw\n';
    assert.deepEqual(
        Array.from(parseZfsMounts(text), t => t.source),
        ['pool/new', 'pool/data']
    );
});
