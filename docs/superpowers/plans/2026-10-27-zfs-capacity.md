# ZFS Capacity Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Mounted ZFS capacity in the existing Main Disk selector and panel.
**Architecture:** A small independently testable mount/capacity module; async GIO
adapter; focused integration with existing discovery, selection, and collectors.
**Tech Stack:** TypeScript, GIO, Node's built-in test runner.
**Spec:** ../specs/2026-10-27-zfs-capacity-design.md

## Global Constraints

No root, required libgtop, or OpenZFS CLI. Preserve physical I/O and existing IDs.
Discover ZFS only. Retain missing selections. Do not aggregate dataset capacity.

## Review Focus

- Unmount/overmount while sampling: suppress results from a replacement mount.
- Missing lsblk: ZFS discovery must still run.
- Missing dataset in preferences: preserve its ID and show unavailable.
- Zero/full capacity: valid zero values must render.
- Forced collector modes: ZFS works in auto, proc, and GTop selections.

### Task 1: Mount and capacity helpers

Files: create src/storage/filesystem.ts and tests/storage-filesystem.test.mjs.
Interfaces: parseZfsMounts(text), isFilesystemId(id), filesystemUsage(size, used,
available), sampleFilesystem(id, readMountinfo, queryUsage).

- [x] Write failing Node tests: escapes, roots, duplicates, multiple datasets,
      non-ZFS, mount replacement, invalid values, reserved blocks, zero/full usage.
- [x] Run npm test; expect missing-module failure before implementation.
- [x] Implement pure helpers; verify mount identity before and after async query.
- [x] Run npm test; expect all tests pass.

### Task 2: Integration and selection

Files: src/utils/utils.ts, src/storage/storageMonitor.ts, src/prefs/storage.ts,
src/storage/storageHeader.ts; tests/storage-integration.test.mjs.
Consumes Task 1 helpers. Produces filesystem targets in listDisksAsync and GIO
sampling in all storage usage modes, while existing collectors remain available.

- [x] Write/run failing integration tests for lsblk absence, selection persistence,
      dataset sampling across modes, disappearance, and physical I/O isolation.
- [x] Implement discovery independently of lsblk success; GIO async attributes
      with filesystem type validation and task cancellation. Preserve unavailable
      dataset selection in monitor and preferences. Render valid zeros.
- [x] Run npm test, tsc --noEmit, eslint; expect pass.

### Task 3: Documentation, verification, publication

Files: docs/zfs-storage.md and docs/zfs-pull-request.md; package.json test script.

- [x] Document NixOS dependency shell, build, package, install/reload, df comparison,
      modes, unmount tests, limitations; supply an upstream PR description.
- [x] Run tests, compile, lint, formatting, schema validation, package checks.
- [x] Review entire diff and commit to a feature branch; publish to user's fork.
