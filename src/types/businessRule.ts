export type BusinessRuleOperator =
  | "equals"
  | "does not equal"
  | "is greater than"
  | "is greater than or equal to"
  | "is less than"
  | "is less than or equal to"
  | "contains"
  | "does not contain"
  | "starts with"
  | "ends with"
  | "is empty"
  | "is not empty"

export const UNARY_OPERATORS: BusinessRuleOperator[] = ["is empty", "is not empty"]

export type BusinessRuleLogic = "AND" | "OR"

export interface BusinessRule {
  id: string
  factId: string           // references Fact.id from the outcome model
  factField?: string       // optional sub-path into the resolved fact when it is an object (e.g. "tier")
  operator: BusinessRuleOperator
  value?: string           // static comparison value
  compareToFactId?: string // OR compare to another fact — mutually exclusive with value
  compareToFactField?: string // optional sub-path into the compared-to fact when it is an object
  evaluationMode?: "deterministic" | "llm" // defaults to deterministic
  llmPrompt?: string       // natural language description used when evaluationMode === "llm"
}
