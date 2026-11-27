# Develop and review modules in the frontend/backend refactor

The [Chinese guide](../../../zh/how-to/platform/refactor-module-boundaries.md) specifies the repository rules for code under apps, packages/core and extensions.

| Change | Owner and review criterion |
| --- | --- |
| HTTP contract and endpoint | Declare the operation under apps/server/rest-interfaces. Controllers map authenticated input and results. The web app calls REST. |
| Business method | Declare the public TypeScript contract in the owning module’s service file. Put authorization, transactions, use-case sequencing and internal rules in application. Callers depend on the public contract. |
| Replaceable functionality | Declare the contract in the owning module. Add the implementation under extensions/module/category/key and declare it in the category registry. Bootstrap selects implementations. Host-specific conversions belong to the module’s adapters. |
| Device and infrastructure contracts | Device commands address a specific client. The shared protocol defines envelopes, acknowledgements and results. Keep common types, storage drivers and the platform Agent runtime in their respective foundation modules. Foundation dependencies point inward. |
| State and failure | Name the state owner, identifier, success condition and retry behavior. Persist accepted work, use idempotency keys on retry and verify ownership before completing a recovered job. Return a safe error code, error ID and request ID. |
| Verification | Put unit tests under test/UT and end-to-end scenarios directly under test/ST. Update the contract, affected callers and documentation together. |

Use the [observation service](../../../../packages/core/observation/trace-service.ts) and [device protocol](../../../../packages/core/foundation/device-protocol/index.ts) as reference contracts.
