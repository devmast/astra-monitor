import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const pools = await loadModule('../src/storage/pools.ts');

test('snapshot accounting sums own dataset properties once, not recursive used or individual snapshots', () => {
    const result = pools.parseZfsAccounting(
        'tank\t1000\t10\t20\t0\n' +
        'tank/home\t900\t300\t500\t100\n' +
        'tank/empty\t0\t0\t0\t0\n'
    ).get('tank');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        used: 1000, snapshots: 310, data: 520, reservations: 100, other: 70,
    });
});

test('accounting requires a root and complete valid rows; unrelated pool failure stays isolated', () => {
    for(const invalid of [
        'tank/home\t90\t30\t60\t0',
        'tank\t100\t0\t1\t0\ntank/home\t90\t-\t60\t0',
        'tank\t100\t0\t1\t0\ntank/home\t90\t80\t30\t0',
        'tank\t100\t0\t1\t0\ntank/home\t90\tNaN\t30\t0',
        'tank\t9007199254740993\t0\t1\t0',
    ]) {
        const result = pools.parseZfsAccounting(invalid + '\ngood\t100\t0\t100\t0');
        assert.equal(result.has('tank'), false, invalid);
        assert.equal(result.get('good').data, 100);
    }
    assert.equal(pools.parseZfsAccounting('tank\t0\t0\t0\t0').get('tank').snapshots, 0);
});

test('pool members come from explicit status paths, including mirrors and auxiliary devices', () => {
    const result = pools.parseZfsMembers(`  pool: tank
 state: ONLINE
config:
        NAME                  STATE     READ WRITE CKSUM
        tank                  ONLINE       0     0     0
          mirror-0            ONLINE       0     0     0
            /dev/sda3         ONLINE       0     0     0
            /dev/sdb3         ONLINE       0     0     0
        logs
          /dev/nvme0n1p4      ONLINE       0     0     0
errors: No known data errors
  pool: other
config:
        other                 ONLINE       0     0     0
          /dev/sdc1           ONLINE       0     0     0
`);
    assert.deepEqual(Array.from(result.get('tank')), ['/dev/sda3', '/dev/sdb3', '/dev/nvme0n1p4']);
    assert.deepEqual(Array.from(result.get('other')), ['/dev/sdc1']);
    assert.equal(pools.parseZfsMembers('no pools available').size, 0);
});

test('gauge splits raw allocation by accounted snapshot share, preserving total fill', () => {
    const pool = { size: 2000, allocated: 1000,
        accounting: { used: 1200, snapshots: 300, data: 800, reservations: 50, other: 50 } };
    const segments = pools.poolGaugeSegments(pool);
    assert.equal(segments[0].value, 0.375);
    assert.equal(segments[1].value, 0.125);
    assert.equal(segments[1].color, 1);
    assert.equal(segments.reduce((sum, segment) => sum + segment.value, 0), 0.5);
    delete pool.accounting;
    assert.equal(pools.poolGaugeSegments(pool).length, 1);
    pool.accounting = { used: 0, snapshots: 0 };
    assert.equal(pools.poolGaugeSegments(pool).length, 1);
    pool.accounting = { used: 100, snapshots: 100 };
    assert.equal(pools.poolGaugeSegments(pool)[1].value, 0.5);
});

test('storage bars render pool segments while conventional usage stays one color', async () => {
    class Bars {
        setStyle() {}
        updateBars(values) { this.values = values; }
    }
    const { default: StorageBars } = await loadModule('../src/storage/storageBars.ts', {
        'gi://GObject': { default: { registerClass: value => value } },
        '../bars.js': { default: Bars },
        '../config.js': { default: { connect: () => {}, get_string: () => 'cyan' } },
        './pools.js': pools,
    });
    const bar = new StorageBars({});
    bar.setPoolUsage({ size: 100, allocated: 80, accounting: { used: 100, snapshots: 25 } });
    assert.equal(bar.values[0].length, 2);
    assert.equal(bar.values[0][1].value, 0.2);
    bar.setUsage({ usePercentage: 80 });
    assert.equal(bar.values[0].length, 1);
});
