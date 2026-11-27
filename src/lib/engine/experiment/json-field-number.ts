/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

type JsonObject = Record<string, unknown>;

const JSON_STRING_OR_NUMBER = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function numberKey(source: string): string {
  const [coefficient, exponent = '0'] = source.split(/[eE]/);
  const negative = coefficient.startsWith('-');
  const [whole, fraction = ''] = (negative ? coefficient.slice(1) : coefficient).split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (digits.length === 0) return '0';

  let end = digits.length;
  while (digits[end - 1] === '0') end -= 1;
  const scale = BigInt(exponent) + BigInt(digits.length - end - fraction.length);
  return `${negative ? '-' : ''}${digits.slice(0, end)}e${scale}`;
}

export type JsonNumberEvidence = number | { numberLiteral: string };

export class JsonFieldNumber {
  constructor(readonly value: number, readonly source: string) {}

  equals(other: unknown): boolean {
    const value = other instanceof JsonFieldNumber ? other.value : other;
    if (typeof value !== 'number' || value !== this.value) return false;
    const source = other instanceof JsonFieldNumber ? other.source : String(value);
    return this.source === source || numberKey(this.source) === numberKey(source);
  }

  toEvidence(): JsonNumberEvidence {
    if (Number.isFinite(this.value)
      && (!Number.isInteger(this.value) || Number.isSafeInteger(this.value))
      && this.equals(this.value)) {
      return this.value;
    }
    return { numberLiteral: this.source };
  }
}

function objectAt(root: unknown, path: readonly string[]): JsonObject | undefined {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as JsonObject)[key];
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function parseJsonWithNumericFields(text: string, path: readonly string[] = []): unknown {
  const parsed: unknown = JSON.parse(text);
  const fields = objectAt(parsed, path);
  if (!fields) return parsed;
  const numericFields = Object.entries(fields).filter((entry): entry is [string, number] => (
    typeof entry[1] === 'number'
  ));
  if (numericFields.length === 0) return parsed;

  // Validate the original JSON before quoting numbers. Quoting alone could accept invalid numeric keys.
  const withNumberStrings: unknown = JSON.parse(text.replace(JSON_STRING_OR_NUMBER, (token) => (
    token.startsWith('"') ? token : JSON.stringify(token)
  )));
  const sources = objectAt(withNumberStrings, path);
  for (const [key, value] of numericFields) {
    const source = sources?.[key];
    if (typeof source !== 'string') throw new SyntaxError('Missing JSON number literal');
    fields[key] = new JsonFieldNumber(value, source);
  }
  return parsed;
}
