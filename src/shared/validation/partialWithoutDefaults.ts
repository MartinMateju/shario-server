import { z } from "zod";

/**
 * `schema.partial()` for PATCH bodies.
 *
 * Zod keeps a field's `.default()` when the object is made partial, so an
 * omitted key is still filled with the create-time default and a partial
 * update silently overwrites stored data. This strips top-level defaults
 * before making every field optional, so omitted keys stay absent.
 */
export const partialWithoutDefaults = <Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
): ReturnType<z.ZodObject<Shape>["partial"]> => {
  const shape: Record<string, z.ZodType> = {};

  for (const [key, value] of Object.entries(schema.shape)) {
    let field = value as z.ZodType;
    while (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
      field = field.unwrap() as z.ZodType;
    }
    shape[key] = field.optional();
  }

  return z.object(shape) as unknown as ReturnType<
    z.ZodObject<Shape>["partial"]
  >;
};
