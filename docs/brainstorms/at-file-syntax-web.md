# Brainstorm: @file syntax in web input with server autocomplete

## The idea

Design support for TUI-style `@file` references in the Pimote web input: users can type `@...`, get autocomplete suggestions from the server, and have references resolved server-side at send time before messages are forwarded to the SDK.

## Key decisions

1. **Target behavior: match TUI semantics**
   - Chosen: Parity with TUI behavior for `@file` usage, including send-time attachment semantics and path handling.
   - Why: User explicitly wants behavior equivalent to TUI, not a web-specific variant.

2. **Where replacement happens: server-side before SDK**
   - Chosen: Client inserts selected tokens only; server resolves references during send processing.
   - Why: Keeps client lightweight and avoids loading full file content in browser memory.

3. **Autocomplete source: server-provided**
   - Chosen: Client asks server for suggestions; server computes candidates.
   - Why: Centralizes filesystem access and keeps path logic consistent across clients.

4. **Path scope and flexibility**
   - Chosen: Keep TUI flexibility (`./`, `../`, `~/`, absolute paths), not cwd-only sandboxed suggestions.
   - Why: User explicitly requested full TUI behavior.

5. **Interaction model: desktop + mobile**
   - Chosen: Both supported. Desktop uses keyboard interactions; mobile uses tap-based suggestion selection.
   - Why: User called out mobile form factor as a requirement.

6. **Autocomplete trigger scope**
   - Chosen: In web, only `@...` references should trigger this feature; no generic non-`@` path completion.
   - Why: User chose reduced scope for web UX despite TUI supporting broader path completion.

7. **Streaming behavior parity**
   - Chosen: `@...` resolution should work for normal prompts and streaming queue paths (`steer`, `follow_up`).
   - Why: Keeps behavior consistent across send modes.

8. **Rendering UX parity**
   - Chosen: Keep editor plain text pre-send; post-send message rendering should match attachment-style UX (not inline file text).
   - Why: User prefers TUI-like post-send presentation while preserving current simple input experience.

9. **Optimistic message behavior**
   - Chosen: Keep current optimistic echo behavior in web.
   - Why: User wants parity with existing Pimote behavior and no special case for optimistic rendering changes.

10. **Literal `@` handling**
    - Chosen: Only treat as file ref when token matches valid reference parsing; otherwise leave as normal text.
    - Why: Avoids introducing explicit escape syntax unless necessary.

11. **Multiple refs and quoted paths**
    - Chosen: Support multiple `@...` refs per message and quoted paths with spaces.
    - Why: Needed for practical parity and explicitly requested.

12. **File type coverage**
    - Chosen: Match TUI attachment coverage (same supported types, including PDFs).
    - Why: User requested same coverage as TUI.

13. **Autocomplete implementation strategy**
    - Chosen: Reuse pi-tui autocomplete logic on server for fast parity.
    - Why: User preferred direct reuse over reimplementation.

14. **Missing `fd` behavior**
    - Chosen: TUI-like graceful degradation with install guidance (feature reduced, app still usable).
    - Why: Balances UX resilience and practical deployment constraints.

## Direction

Implement web `@file` as a server-driven feature:

- **Autocomplete**: add server command(s) for `@` suggestions using reused pi-tui path/autocomplete logic.
- **Send-time transform**: resolve `@` references server-side for `prompt`, `steer`, and `follow_up`, then forward expanded message/attachments into the SDK path.
- **Rendering**: preserve plain editor input, but represent resolved refs as attachments in message UX after send.
- **Fallbacks**: if `fd` is unavailable, notify with install guidance and degrade gracefully.

## Open questions

- Exact fallback quality when `fd` is unavailable (e.g., no fuzzy suggestions vs. reduced non-fuzzy directory listing) should be finalized during architecture.
- Whether to implement attachment-style rendering via protocol shape changes or client-side interpretation of transformed message content should be decided in architecture.
