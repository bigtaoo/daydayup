/** Types for `stepOrder.mjs` — deliberately free of any Node typing, see that file's header. */
export type StepCall = { field: string; className: string | null; label: string };

export function labelKey(label: string): [number, string] | null;
export function labelLessThan(a: string, b: string): boolean;
export function stepBody(gameEngineSrc: string): string | null;
export function fieldClasses(gameEngineSrc: string): Map<string, string>;
export function parseStepOrder(gameEngineSrc: string): { calls: StepCall[]; problems: string[] };
export function parseSystemStep(systemSrc: string): { declared: string | null; stated: boolean };
export function checkStepNumbering(gameEngineSrc: string, systems: Map<string, string>): string[];
export function parseDesignStepLabels(designDocSrc: string): string[] | null;
