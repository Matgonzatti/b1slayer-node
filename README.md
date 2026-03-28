# b1slayer-node

A lightweight SAP Business One Service Layer client for Node.js and TypeScript.

## Features

- Fluent and easy Service Layer requests
- Automatic session management with cookie persistence
- Automatic retry for transient failures and 401 relogin
- Batch operations (`$batch`) support
- Attachments (`Attachments2`) upload, patch and download
- Works with OData v4 (`/b1s/v2`) and OData v3 (`/b1s/v1`)

## Installation

```bash
npm install b1slayer-node
```

## Quick start

```ts
import { ServiceLayerClient } from "b1slayer-node";

const serviceLayer = new ServiceLayerClient({
  baseUrl: "https://sapserver:50000/b1s/v2",
  companyDB: "SBODEMO",
  userName: "manager",
  password: "12345"
});

const orders = await serviceLayer
  .request("Orders")
  .filter("DocEntry gt 0")
  .select("DocEntry,CardCode")
  .orderBy("DocEntry desc")
  .withPageSize(50)
  .get<Array<{ DocEntry: number; CardCode: string }>>();

await serviceLayer.request("BusinessPartners", "C00001").patch({
  CardName: "Updated BP name"
});
```

## Batch example

```ts
import { SLBatchRequest } from "b1slayer-node";

const req1 = new SLBatchRequest("POST", "BusinessPartners", {
  CardCode: "C00001",
  CardName: "New BP"
}, 1).withReturnNoContent();

const req2 = new SLBatchRequest("PATCH", "BusinessPartners('C00001')", {
  CardName: "Updated BP"
}, 2);

const req3 = new SLBatchRequest("DELETE", "BusinessPartners('C00001')", undefined, 3);

const result = await serviceLayer.postBatch([req1, req2, req3]);
```

## Attachments

```ts
const created = await serviceLayer.postAttachmentFromPath("/tmp/invoice.pdf");
await serviceLayer.patchAttachment(123, "invoice-new.pdf", Buffer.from("hello"));
const bytes = await serviceLayer.getAttachmentAsBytes(123);
```

## Status

This is the first implementation baseline for the Node.js package and mirrors the main capabilities from the .NET `B1SLayer` project.

## CI/CD and npm publish

The project includes:

- CI workflow: `.github/workflows/ci.yml`
- Publish workflow: `.github/workflows/publish.yml`

To enable automated publish on GitHub Release:

1. Create a npm token with publish permission.
2. Add it in GitHub repo secrets as `NPM_TOKEN`.
3. Update `package.json` repository URLs (`your-org/b1slayer-node`) to your actual repository.
4. Bump package version (`npm version patch|minor|major`).
5. Push tag and publish a GitHub Release for that tag.

The publish workflow runs `npm run ci` before `npm publish --provenance`.
