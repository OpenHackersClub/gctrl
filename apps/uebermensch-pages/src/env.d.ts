/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type Runtime = import("@astrojs/cloudflare").Runtime<{
  VAULT: R2Bucket
}>

declare namespace App {
  interface Locals extends Runtime {}
}
