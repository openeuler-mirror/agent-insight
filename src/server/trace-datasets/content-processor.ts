import type { NormalizedUnit } from './normalizer';
export const PROCESSOR_VERSION = 'identity-v1';
export async function processContent(unit: NormalizedUnit): Promise<NormalizedUnit> { return unit; }
