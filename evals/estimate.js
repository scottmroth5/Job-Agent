// Shared by the eval scripts' budget checks: an estimate is { [model]: usd | null }, null when the model has no price
// in its rate table. A model without a price would count as $0 against --max-usd, so the scripts refuse to run it.

/**
 * The models in an estimate that have no price.
 * @param {Record<string, number | null>} estimate
 */
export const unpriced = (estimate) =>
  Object.entries(estimate)
    .filter(([, usd]) => usd == null)
    .map(([model]) => model);
