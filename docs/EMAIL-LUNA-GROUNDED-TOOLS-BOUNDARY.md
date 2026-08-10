# Email Luna grounded tools boundary

This module is a read-only adapter over trusted, server-injected query owners. Guest/model input reaches it as JSON-compatible data; it cannot supply executable JavaScript Proxies, accessors, functions, or owner implementations. Query owners are trusted server code but their returned data is still validated and projected fail closed.

## Proxy contract

- A Proxy received directly at a module boundary (configuration, authority, owner map, query arguments, synchronous owner return, wrapper, array, or row) is rejected with the module-initialization-pinned native Proxy detector **before this module performs reflection**. Trapping direct-boundary probes therefore execute zero traps.
- If a trusted `async` owner resolves to a Proxy, native Promise resolution necessarily performs `Get(value, "then")` before this module receives the fulfillment value. Exactly one such native `then` probe is unavoidable and is not claimed preventable. After fulfillment reaches the module, the pinned Proxy detector rejects it before any module reflection.
- Rejected owner results produce only the bounded frozen DTO; no row data or executable capability is projected or leaked.

The boundary also pins every intrinsic it relies on during module initialization. Post-import monkeypatches of array iteration, reflection, property definition, freezing, Promise continuation, or other used built-ins must not execute or change ordinary output shape.
