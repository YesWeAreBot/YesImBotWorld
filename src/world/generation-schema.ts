type Schema = Record<string, unknown>;
const record = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);

/** Decoder-facing subset of the World contract. Runtime validation remains the
 * authority for field exclusivity, unique references, permissions and evidence.
 * Keep the native-tool declaration intact for providers using that protocol. */
export function worldGenerationSchema(contract: Schema): Schema {
  const schema = structuredClone(contract);
  const properties = schema.properties;
  if (record(properties) && record(properties.repair) && Array.isArray(schema.oneOf)) {
    const completeRule = schema.oneOf[0];
    if (!record(completeRule) || !Array.isArray(completeRule.required)) throw new Error("World repair contract is missing its complete-proposal requirements.");
    const completeProperties = { ...properties };
    delete completeProperties.repair;
    const complete: Schema = { ...schema, required: completeRule.required, properties: completeProperties };
    delete complete.oneOf;
    // xgrammar does not combine an outer properties declaration with bare
    // required-only union branches. Each alternative must declare its own shape.
    return project({ anyOf: [complete, {
      type: "object", additionalProperties: false, required: ["repair"],
      properties: { repair: properties.repair },
    }] });
  }
  return project(schema);
}

function project(schema: Schema): Schema {
  // uniqueItems is rejected by vLLM/xgrammar; not is silently ignored there and
  // rejected by its guidance fallback. Neither may replace local validation.
  delete schema.not;
  delete schema.uniqueItems;
  // Visit schema positions only: a property named "not" or "uniqueItems", or an
  // object inside enum/examples, is data rather than a schema keyword.
  for (const key of ["properties", "$defs", "definitions"]) {
    const fields = schema[key];
    if (record(fields)) for (const value of Object.values(fields)) if (record(value)) project(value);
  }
  for (const key of ["items", "additionalProperties"]) if (record(schema[key])) project(schema[key]);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives)) for (const value of alternatives) if (record(value)) project(value);
  }
  return schema;
}
