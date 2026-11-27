/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { safeUUID } from '@/lib/safe-uuid';

export interface CatalogParameter {
  id: string;
  name: string;
  type: string;
  description: string;
  required: boolean;
  original: unknown;
}
export interface CatalogTool {
  id: string;
  name: string;
  description: string;
  original: Record<string, unknown>;
  parameters: CatalogParameter[];
  schemaEditable: boolean;
}
export interface CatalogForm {
  provided: boolean;
  tools: CatalogTool[];
  wrapper?: Record<string, unknown>;
  error?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const catalogParameterTypes = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
export function newCatalogParameter(): CatalogParameter {
  return { id: safeUUID(), name: '', type: 'string', description: '', required: false, original: {} };
}
export function newCatalogTool(): CatalogTool {
  return { id: safeUUID(), name: '', description: '', original: {}, parameters: [], schemaEditable: true };
}
export function readCatalogForm(value: unknown): CatalogForm {
  if (value === undefined || value === null || value === '') return { provided: false, tools: [] };
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) : value;
    if (raw === null) return { provided: false, tools: [] };
    const wrapper = object(raw) && raw.schemaVersion === 1 && Array.isArray(raw.availableTools) ? raw : undefined;
    const rows = wrapper ? wrapper.availableTools : raw;
    if (!Array.isArray(rows) || rows.some(row => !object(row))) throw Error();
    return { provided: true, ...(wrapper ? { wrapper } : {}), tools: rows.map(row => {
      const schema = row.inputSchema;
      const editable = schema === undefined || object(schema) && (schema.type === 'object' || object(schema.properties) || Object.keys(schema).length === 0);
      const required = object(schema) && Array.isArray(schema.required) ? schema.required : [];
      const properties = object(schema) && object(schema.properties) ? schema.properties : {};
      return { id: safeUUID(), name: typeof row.name === 'string' ? row.name : '', description: typeof row.description === 'string' ? row.description : '',
        original: row, schemaEditable: editable, parameters: editable ? Object.entries(properties).map(([name, definition]) => ({
          id: safeUUID(), name, type: object(definition) && typeof definition.type === 'string' && catalogParameterTypes.includes(definition.type) ? definition.type : '',
          description: object(definition) && typeof definition.description === 'string' ? definition.description : '', required: required.includes(name), original: definition,
        })) : [],
      };
    }) };
  } catch {
    return { provided: false, tools: [], error: '无法读取已有工具目录，请取消检查原数据，或明确重新配置。' };
  }
}
export function serializeCatalogForm(draft: CatalogForm): unknown {
  if (draft.error) throw Error(draft.error);
  if (!draft.provided) return '';
  const names = new Set<string>();
  const tools = draft.tools.map(tool => {
    const name = tool.name.trim();
    if (!name) throw Error('工具名称不能为空');
    if (names.has(name.toLowerCase())) throw Error('工具名称不能重复');
    names.add(name.toLowerCase());
    const result: Record<string, unknown> = { ...tool.original, name };
    if (tool.description.trim()) result.description = tool.description.trim(); else delete result.description;
    if (tool.schemaEditable && (tool.original.inputSchema !== undefined || tool.parameters.length)) {
      const schema = object(tool.original.inputSchema) ? tool.original.inputSchema : {};
      if (!tool.parameters.length && !Object.hasOwn(schema, 'properties')) { result.inputSchema = schema; return result; }
      const properties: Record<string, unknown> = {};
      const oldNames = new Set(object(schema.properties) ? Object.keys(schema.properties) : []);
      const required = Array.isArray(schema.required) ? schema.required.filter(key => typeof key === 'string' && !oldNames.has(key)) : [];
      for (const parameter of tool.parameters) {
        const key = parameter.name.trim();
        if (!key) throw Error('参数名称不能为空');
        if (Object.hasOwn(properties, key)) throw Error('同一工具的参数名称不能重复');
        let definition = parameter.original;
        if (!object(definition) && (parameter.type || parameter.description.trim())) throw Error('复杂参数定义只支持重命名、设置必填或删除，不能修改类型与说明');
        if (object(definition)) {
          definition = { ...(object(definition) ? definition : {}), ...(parameter.type ? { type: parameter.type } : {}) };
          if (parameter.description.trim()) (definition as Record<string, unknown>).description = parameter.description.trim();
          else delete (definition as Record<string, unknown>).description;
        }
        Object.defineProperty(properties, key, { value: definition, enumerable: true, configurable: true, writable: true });
        if (parameter.required) required.push(key);
      }
      result.inputSchema = { ...schema, ...(tool.parameters.length && !schema.type ? { type: 'object' } : {}), properties,
        ...(required.length || Object.hasOwn(schema, 'required') ? { required } : {}),
      };
    }
    return result;
  });
  return draft.wrapper ? { ...draft.wrapper, availableTools: tools } : tools;
}
