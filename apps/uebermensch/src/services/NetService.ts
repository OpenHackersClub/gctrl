import { Context, type Effect } from "effect";
import type { NetError } from "../errors.js";

export type NetSearchRequest = {
  readonly query: string;
  readonly maxResults?: number;
};

export type NetSearchResult = {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
};

export type NetSearchResponse = {
  readonly query: string;
  readonly results: ReadonlyArray<NetSearchResult>;
};

export type NetFetchRequest = {
  readonly url: string;
  readonly accept?: "html" | "markdown";
};

export type NetFetchResponse = {
  readonly url: string;
  readonly status: number;
  readonly content: string;
  readonly contentType: string;
};

export interface NetServiceShape {
  readonly search: (req: NetSearchRequest) => Effect.Effect<NetSearchResponse, NetError>;
  readonly fetch: (req: NetFetchRequest) => Effect.Effect<NetFetchResponse, NetError>;
}

export class NetService extends Context.Tag("uebermensch/NetService")<
  NetService,
  NetServiceShape
>() {}
