export type ZfsPool = {
    name: string;
    size: number;
    allocated: number;
    free: number;
    capacity: number;
    health: string;
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
