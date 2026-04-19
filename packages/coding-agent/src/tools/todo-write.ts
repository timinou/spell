import * as async_hooks from "node:async_hooks";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_ORG_CONFIG,
	findItemById,
	resolveCategories,
	updateItemStateInFile,
	writeJournal,
} from "@oh-my-pi/pi-org";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import { renderPromptTemplate } from "../config/prompt-templates";
import { applyPolicyGates, type TaskPolicy, type TaskPolicyGates } from "../config/task-policies";
import { createWaveSnapshot } from "../orchestrators/fluid/wave-snapshot";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { buildOrgConfig } from "../plan-mode/org-plan";
import todoWriteDescription from "../prompts/tools/todo-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { resolveArtifactScopeFromArtifactsDir, resolveArtifactScopeFromSessionFile } from "../session/artifacts";
import type { GitBaseline } from "../session/git-baseline";
import type { SessionEntry } from "../session/session-manager";
import { buildTaskUri, resolveTaskUri, type TaskUriContext } from "../swarm/uri";
import { type GateFailure, verifyGates } from "../task/gate-verification";
import { MutableDag } from "../task/mutable-dag";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "./render-utils";
