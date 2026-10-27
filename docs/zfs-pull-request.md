# Add mounted ZFS datasets as storage capacity targets

Mounted ZFS filesystems such as `zpool/home` at `/home` were missing from Main
Disk because discovery relied entirely on lsblk. Both capacity collectors then
lacked a mountpoint to query.

Discover mounted ZFS roots from mountinfo alongside existing block devices, with
stable namespaced selection IDs and escaped-path handling. Use asynchronous GIO
filesystem statistics for ZFS in every collector mode, preserving independent
used/available values and df percentage semantics. Retain temporarily missing
dataset selections, suppress samples if the mount changes, and render valid zero
values. Existing block-device collection and physical I/O are unchanged.

No root, libgtop, or OpenZFS command dependency is added. Pool statistics and
dataset I/O remain out of scope. See `docs/zfs-storage.md` for NixOS build,
installation, and manual ZFS validation instructions.

Validation: Node regression/integration tests, TypeScript compilation, ESLint,
format checks, schema validation, and staged ZIP content checks. Live GNOME/ZFS
and Nix evaluation still need testing on the target host.
