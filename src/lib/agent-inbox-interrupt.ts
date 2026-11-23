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

import { Interrupt } from "@langchain/langgraph-sdk";
import { HITLRequest } from "@/components/thread/agent-inbox/types";

export function isAgentInboxInterruptSchema(
  value: unknown,
): value is Interrupt<HITLRequest> | Interrupt<HITLRequest>[] {
  const valueAsObject = Array.isArray(value) ? value[0] : value;
  if (!valueAsObject || typeof valueAsObject !== "object") {
    return false;
  }

  const interrupt = valueAsObject as Interrupt<HITLRequest>;
  if (!interrupt.value || typeof interrupt.value !== "object") {
    return false;
  }

  const hitlValue = interrupt.value as Partial<HITLRequest>;
  const { action_requests: actionRequests, review_configs: reviewConfigs } =
    hitlValue;

  if (!Array.isArray(actionRequests) || actionRequests.length === 0) {
    return false;
  }
  if (!Array.isArray(reviewConfigs) || reviewConfigs.length === 0) {
    return false;
  }

  const hasValidActionRequests = actionRequests.every((request) => {
    return (
      request &&
      typeof request === "object" &&
      "name" in request &&
      typeof request.name === "string" &&
      "args" in request &&
      request.args !== null &&
      typeof request.args === "object"
    );
  });

  const hasValidConfigs = reviewConfigs.every((config) => {
    return (
      config &&
      typeof config === "object" &&
      "action_name" in config &&
      typeof config.action_name === "string" &&
      "allowed_decisions" in config &&
      Array.isArray(config.allowed_decisions)
    );
  });

  return hasValidActionRequests && hasValidConfigs;
}
