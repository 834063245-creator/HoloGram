;; Zig Structure Queries

(function_declaration) @fn
(call_expression) @call
(builtin_function) @call

;; ── Variables ──
(variable_declaration) @var

;; ── Writes ──
(assignment_expression) @write

;; ── Usage ──
(identifier) @usage
