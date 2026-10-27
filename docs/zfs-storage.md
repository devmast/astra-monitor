# Mounted ZFS storage usage

Mounted ZFS datasets now appear in **Preferences → Storage → Main Disk**, for
example `ZFS: zpool/home (/home)`. The existing panel values, tooltip, and usage
visualizations show the selected dataset's filesystem capacity. Physical disk
menus and `/proc/diskstats` I/O retain their existing behavior; dataset I/O is not
implemented.

## Why the change is needed

At the fork's baseline (`134327199e48f40d7f2371de46d8e2aea32ab09d`),
`Utils.listDisksAsync()` discovers only lsblk leaf devices. Mounted ZFS datasets
are logical filesystems absent from that list. Both usage collectors depend on
those discovered targets, so installing optional libgtop alone cannot fix discovery.

Discovery now also reads `/proc/self/mountinfo`. Only mounted ZFS dataset roots
are added; unmounted datasets, `mountpoint=none`, and inactive `canmount=off`
datasets are absent. Subdirectory bind mounts are omitted. Exact duplicates are
collapsed, while distinct mountpoints remain independently selectable. Dataset
IDs encode source and mountpoint in a separate namespace and persist in the
existing settings/profile mechanism. Existing block-device IDs are unchanged.

ZFS always uses asynchronous GIO filesystem queries, even if the configured
source is `GTop` or `lsblk`. No ZFS utility, optional libgtop, or root access is
required for capacity. Conventional filesystems keep their existing collectors.

## Capacity semantics

GIO provides `filesystem::size`, `filesystem::used`, and `filesystem::free`.
On Linux these correspond to filesystem total, allocated blocks, and space
available to the caller. Available space is displayed by the existing “free”
indicator. It is read separately rather than computed as total minus used.
Percentage is `ceil(100 * used / (used + available))`, matching `df` rounding.
Reserved blocks can make used plus available smaller than total.

Dataset quotas, reservations, snapshots, and shared pool capacity affect the
filesystem's reported values. This is the mounted filesystem view, not `zpool`
allocation or recursive `zfs list` accounting. Never sum dataset totals to
estimate pool capacity.

## Build and test on NixOS

From your fork:

```bash
git clone --branch feat/zfs-storage-usage https://github.com/devmast/astra-monitor.git
cd astra-monitor
nix-shell -p nodejs typescript glib gnome-shell gettext zip
npm install
npm test
npx tsc --noEmit
npx eslint .
npx eslint --ext .mjs tests
glib-compile-schemas --strict schemas
npx tsc
```

Node 18 or newer is needed for the built-in test runner. The VM module warning
is expected: tests execute the actual TypeScript with GNOME dependencies mocked.
The Nix shell supplies build tools; it does not replace your running GNOME Shell.
The extension declares GNOME Shell 45–51 compatibility in `metadata.json`.
No system configuration changes or ZFS permissions are needed for this build.

Package the compiled extension without invoking the repository's formatting and
translation regeneration scripts:

```bash
mkdir -p work/zfs-package
cp -r build/* work/zfs-package/
cp -r metadata.json stylesheet.css schemas icons po work/zfs-package/
(cd work/zfs-package && zip -qr ../../monitor@astraext.github.io.shell-extension.zip .)
gnome-extensions install --force ./monitor@astraext.github.io.shell-extension.zip
```

Log out and back in to load the new code on Wayland, then run:

```bash
gnome-extensions enable monitor@astraext.github.io
gnome-extensions prefs monitor@astraext.github.io
```

If NixOS/Home Manager manages this extension declaratively, ensure the user-local
build is the version actually loaded; avoid simultaneously installing competing
copies. GNOME's Extensions app can show extension details and errors.

## Manual verification

1. Confirm the mount with `findmnt -t zfs`; select
   `ZFS: zpool/home (/home)` in Main Disk.
2. Enable percentage, used, and free indicators as desired. Compare the tooltip
   total and panel values with `df -B1 --output=size,used,avail,pcent /home`.
   Display units and live writes can introduce small visible differences.
   `gio info -f /home` shows the exact GIO attributes used by this implementation.
3. Repeat with Storage Usage sources Auto, GTop, and lsblk. ZFS capacity should
   work with each, including without libgtop installed.
4. Reload the extension or log out/in; confirm the same dataset remains selected.
5. Select an existing ext4 target; confirm previous capacity behavior. Check that
   physical read/write rates and the device menu still update during disk activity.
6. On a disposable test dataset, unmount it while selected. Current capacity
   should become unavailable and preferences should retain an Unavailable entry.
   Remount at the same path; sampling resumes without selecting it again.
   Do not unmount an active `/home` or root filesystem for this test.
7. If available, repeat with multiple datasets, quotas, and a path containing
   spaces. Each dataset is independent and totals are never aggregated.

## Limits and verification scope

Mount identity and ancestor visibility are checked before and after each query,
and GIO must report ZFS.
Unmounts, inaccessible paths, missing attributes, and invalid statistics yield
no capacity sample. Zero capacity values display as `0 B` (and zero usage as `0%`), independently of
the general dash-for-zero preference. The saved selection is retained; a renamed dataset or changed
mountpoint needs explicit reselection. Preferences refresh their choices when
opened; there is no live mount notification service.

Automated tests cover parsing, escapes, duplicates, capacity semantics, mount
replacement, discovery failure, persistence, collector routing, GIO attributes,
cancellation, and conventional collection. Type checking and linting validate the
integration. Actual GNOME rendering, Nix evaluation, and live ZFS quota behavior
require validation on a GNOME/ZFS host; the cloud workspace has no such runtime.
