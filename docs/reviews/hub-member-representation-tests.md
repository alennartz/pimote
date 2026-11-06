# Test Review: Hub Member Representation

**Plan:** `docs/plans/hub-member-representation.md`
**Brainstorm:** `docs/brainstorms/hub-member-representation.md`
**Date:** 2026-11-06

## Summary

The original tests left safety, routing, and interaction gaps in the approved contract. The user approved the added coverage and corrections. The tests exercise component boundaries and deterministic Git fixtures; they remain red until implementation.

## Findings

### 1. Removal and disband safety lacked coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/folder-registry-worktree.test.ts:317-493`, `server/src/hub-worktrees.test.ts:121-161`
- **Status:** resolved

Added tests for staged, unstaged, and untracked changes, local and remote-tracking branch reachability, all-worktree preflight, and retry after partial removal. The user approved this coverage.

### 2. Activity guard lacked a testable production boundary

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/hub-activity.ts:1-13`, `server/src/hub-activity.test.ts:1-41`, `server/src/folder-registry-worktree.test.ts:469-483`
- **Status:** resolved

The architecture required live-session and external-process checks but did not expose their subtree activity sources. Added the `HubActivity` interface stub and deterministic tests for both sources, descendant paths, sibling paths, source failures, and registry guard integration. The user approved the architecture and test additions. Production wiring remains implementation work.

### 3. Worktree creation and membership gaps

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/folder-registry-worktree.test.ts:154-343`, `server/src/hub-worktrees.test.ts:97-113`
- **Status:** resolved

Added tests for detached source `HEAD`, unchanged dirty source files, ignored hub files, checkout-derived status, default symlinks, persona additions, and marker persistence after the last code member. The user approved this coverage.

### 4. Dashboard and manager routing gaps

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/ws-folder-commands.test.ts:111-135`, `server/src/ws-handler.test.ts:4168-4179`, `server/src/manager/extension.test.ts:170-219,267-286,590-708,898-926`, `server/src/index.test.ts:442-467`
- **Status:** resolved

Added worktree creation and disband routing tests, structured error checks, and manager row and hub-filter coverage. Updated the existing pinned-toolset expectations for the restored manager tool. The user approved these changes.

### 5. Approved interaction flows lacked effective assertions

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/components/FolderCreatorWizard.representation.test.ts:136-194`, `client/src/lib/components/FolderList.disband.test.ts:144-224`, `client/src/lib/components/HubMembersDialog.representation.test.ts:117-152`
- **Status:** resolved

Scoped assertions to the relevant helper, member row, picker, and confirmation dialog. Added default creation and session opening, cancellation, branch warnings, and member editing coverage. The user approved these corrections.

### 6. Rollback assertions could pass without a created worktree

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/folder-registry-worktree.test.ts:208-234,254-286`
- **Status:** resolved

Replaced the vacuous comparison of fake call lists with Git-backed fixtures. The tests prove a checkout existed before rollback and that Git no longer lists it afterward. The user approved this correction.

### 7. Existing-target error text was not part of the interface

- **Category:** over-specified
- **Severity:** warning
- **Location:** `server/src/hub-worktrees.test.ts:114-118`
- **Status:** resolved

The target-collision test now requires a rejection without prescribing its message. The user approved this correction.

## Validation

Server TypeScript compilation and the client check passed. The targeted server suite reported 280 passing and 64 failing tests. The targeted client suite reported 3 passing and 12 failing tests. These failures cover planned behavior and interface stubs that implementation has not completed.
