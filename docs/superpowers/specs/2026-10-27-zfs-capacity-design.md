# Mounted ZFS capacity

Approved focused design: discover mounted ZFS datasets from `/proc/self/mountinfo`,
including escaped paths, independently of lsblk. Preserve block-device discovery
and identifiers. Give datasets a namespaced source-and-mountpoint identifier and
show them in Main Disk preferences. Use asynchronous GIO filesystem statistics
without root, libgtop, or OpenZFS commands. Feed existing capacity/history UI;
physical-device menus and I/O remain unchanged.

Preserve selected dataset IDs when temporarily missing. Verify the mount before
sampling to avoid reporting the filesystem beneath an unmounted dataset. Test
mount parsing, duplicate/bind entries, persistence, disappearance, capacity
semantics, and integration. Document NixOS build and manual verification.

## Approaches

Chosen: add focused ZFS capacity targets alongside existing block targets. This
minimizes regression risk. Deferred: unify all filesystem capacity collectors;
that changes conventional filesystem behavior and deserves separate work.

## Implementation decisions

Use GIO's separate size, used, and free (available to the caller) attributes.
Percentage is ceil(100 \* used / (used + available)), as in df; total can exceed
used + available due to reserved blocks. Do not sum dataset totals as pool size.
Only mounted dataset roots are targets; subdirectory bind mounts are omitted.
Retain distinct mountpoints of the same dataset; collapse identical entries.
Missing samples clear current capacity rather than keep stale data.

No dataset I/O, pool metrics, general filesystem migration, or new runtime
command dependency. Live ZFS/GNOME validation requires the user's NixOS host.
