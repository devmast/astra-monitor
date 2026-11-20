export type ZfsAccounting = {
    used: number;
    snapshots: number;
    data: number;
    reservations: number;
    other: number;
};

export type ZfsPool = {
    name: string;
    size: number;
    allocated: number;
    free: number;
    capacity: number;
    health: string;
    members?: string[];
    accounting?: ZfsAccounting;
};

// zpool list -H -p -o name,size,alloc,free,capacity,health
// Pool allocation includes snapshots and metadata; dataset totals cannot be summed.
export function parseZfsPools(text: string): ZfsPool[] {
    const pools: ZfsPool[] = [];
    for(const line of text.trim().split('\n')) {
        const fields = line.split('\t');
        if(fields.length !== 6 || !fields[0] || !fields[5]) continue;
        const numbers = fields.slice(1, 5);
        if(!numbers.every(value => /^\d+$/.test(value))) continue;
        const [size, allocated, free, capacity] = numbers.map(Number);
        if(![size, allocated, free, capacity].every(Number.isSafeInteger) ||
            size <= 0 || allocated + free > size || capacity > 100) continue;
        pools.push({ name: fields[0], size, allocated, free, capacity, health: fields[5] });
    }
    return pools;
}

// Own dataset properties are additive; recursive used and snapshot used are not.
export function parseZfsAccounting(text: string): Map<string, ZfsAccounting> {
    const totals = new Map<string, ZfsAccounting>();
    const roots = new Map<string, number>();
    const invalid = new Set<string>();
    const seen = new Set<string>();
    for(const line of text.trim().split('\n')) {
        if(!line) continue;
        const fields = line.split('\t');
        const name = fields[0];
        const pool = name.split('/')[0];
        if(fields.length !== 5 || seen.has(name) ||
            !fields.slice(1).every(value => /^\d+$/.test(value))) {
            invalid.add(pool);
            continue;
        }
        seen.add(name);
        const [used, snapshots, data, reservations] = fields.slice(1).map(Number);
        if(![used, snapshots, data, reservations].every(Number.isSafeInteger)) {
            invalid.add(pool);
            continue;
        }
        if(name === pool) roots.set(pool, used);
        const total = totals.get(pool) ?? { used: 0, snapshots: 0, data: 0, reservations: 0, other: 0 };
        total.snapshots += snapshots;
        total.data += data;
        total.reservations += reservations;
        totals.set(pool, total);
    }
    for(const [pool, total] of totals) {
        const used = roots.get(pool);
        const accounted = total.snapshots + total.data + total.reservations;
        if(invalid.has(pool) || used === undefined || !Number.isSafeInteger(accounted) || accounted > used) {
            totals.delete(pool);
            continue;
        }
        total.used = used;
        total.other = used - accounted;
    }
    return totals;
}

export function parseZfsMembers(text: string): Map<string, string[]> {
    const members = new Map<string, string[]>();
    let pool: string | undefined;
    let config = false;
    for(const line of text.split('\n')) {
        const heading = line.match(/^\s*pool:\s+(\S+)\s*$/);
        if(heading) {
            pool = heading[1];
            config = false;
            members.set(pool, []);
        } else if(/^config:\s*$/.test(line)) {
            config = true;
        } else if(/^errors:/.test(line)) {
            config = false;
        } else if(pool && config) {
            const device = line.match(/^\s*(\/dev\/\S+)\s+\S+/)?.[1];
            if(device && !members.get(pool)!.includes(device)) members.get(pool)!.push(device);
        }
    }
    return members;
}

export function poolGaugeSegments(pool: ZfsPool): { color: number; value: number }[] {
    const fill = Math.max(0, Math.min(1, pool.allocated / pool.size));
    const accounting = pool.accounting;
    if(!accounting || accounting.used <= 0 || accounting.snapshots < 0 ||
        accounting.snapshots > accounting.used) return [{ color: 0, value: fill }];
    // Physical allocation and dataset accounting differ. Show the snapshot SHARE
    // within the raw allocation fill, not snapshot bytes as raw physical bytes.
    const snapshots = fill * accounting.snapshots / accounting.used;
    return [{ color: 0, value: fill - snapshots }, { color: 1, value: snapshots }];
}
