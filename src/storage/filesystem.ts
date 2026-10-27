/** Mounted filesystem capacity targets, independent of physical block devices. */
export type FilesystemTarget = {
    id: string;
    source: string;
    mountpoint: string;
    mountId: string;
    filesystem: 'zfs';
};

export type FilesystemUsage = {
    size: number;
    used: number;
    free: number;
    usePercentage: number;
};

const filesystemPrefix = 'filesystem:zfs:';

export function isFilesystemId(id: string | null | undefined): boolean {
    return !!id?.startsWith(filesystemPrefix);
}

function unescapeMount(value: string): string {
    return value.replace(/\\(040|011|012|134)/g, (_match, octal: string) =>
        String.fromCharCode(parseInt(octal, 8))
    );
}

export function parseZfsMounts(text: string): FilesystemTarget[] {
    const mounts = new Map<string, FilesystemTarget | null>();
    const tree = new Map<string, { parentId: string; mountpoint: string }>();
    const visibleIds = new Map<string, string>();
    for(const line of text.split('\n')) {
        const separator = line.indexOf(' - ');
        if(separator < 0) continue;
        const fields = line.slice(0, separator).split(' ');
        const details = line.slice(separator + 3).split(' ');
        if(fields.length < 6 || details.length < 3 || !/^\d+$/.test(fields[0])) continue;
        const mountpoint = unescapeMount(fields[4]);
        if(!mountpoint.startsWith('/')) continue;
        tree.set(fields[0], { parentId: fields[1], mountpoint });
        visibleIds.set(mountpoint, fields[0]);
        // Keep only the last entry at a path, including non-ZFS overmounts.
        mounts.set(mountpoint, null);
        if(details[0] !== 'zfs' || fields[3] !== '/' || !details[1]) continue;
        const source = unescapeMount(details[1]);
        mounts.set(mountpoint, {
            id: `${filesystemPrefix}${encodeURIComponent(source)}:${encodeURIComponent(mountpoint)}`,
            source,
            mountpoint,
            mountId: fields[0],
            filesystem: 'zfs',
        });
    }
    return [...mounts.values()].filter((mount): mount is FilesystemTarget => {
        if(!mount) return false;
        const visited = new Set<string>();
        let id = mount.mountId;
        let childMountpoint = mount.mountpoint;
        while(tree.has(id)) {
            if(visited.has(id)) return false;
            visited.add(id);
            const node = tree.get(id)!;
            // A top mount can be attached to the root of the mount it covers.
            // Such equal-path ancestors do not hide the new mount or its children.
            if(visibleIds.get(node.mountpoint) !== id && node.mountpoint !== childMountpoint)
                return false;
            childMountpoint = node.mountpoint;
            id = node.parentId;
        }
        return true;
    });
}

export function filesystemUsage(
    size: number,
    used: number,
    available: number
): FilesystemUsage | null {
    if(
        ![size, used, available].every(Number.isFinite) ||
        size <= 0 ||
        used < 0 ||
        available < 0 ||
        used + available > size
    )
        return null;
    return {
        size,
        used,
        free: available,
        // df excludes reserved blocks from the percentage denominator.
        usePercentage: used + available > 0 ? Math.ceil((100 * used) / (used + available)) : 0,
    };
}

export async function sampleFilesystem(
    id: string,
    readMountinfo: () => Promise<string>,
    queryUsage: (target: FilesystemTarget) => Promise<FilesystemUsage | null>
): Promise<FilesystemUsage | null> {
    const target = parseZfsMounts(await readMountinfo()).find(mount => mount.id === id);
    if(!target) return null;
    const usage = await queryUsage(target);
    const current = parseZfsMounts(await readMountinfo()).find(mount => mount.id === id);
    // A disappeared or replaced mount must not produce a sample of the filesystem beneath it.
    if(!current || current.mountId !== target.mountId) return null;
    return usage;
}
