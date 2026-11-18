import { obj, type Properties, type Schema, type StaticObject } from '@earendil-works/pi-schema';

type PiToolParameters<T> = Schema<T> & { '~unsafe': T };

/** Build closed tool inputs while preserving pi-schema's inferred type in Pi's ToolDefinition. */
export function toolObject<const P extends Properties>(properties: P): PiToolParameters<StaticObject<P>> {
  return obj(properties) as PiToolParameters<StaticObject<P>>;
}
