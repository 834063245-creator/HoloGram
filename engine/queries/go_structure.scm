;; Go Structure Queries

(function_declaration) @fn
(method_declaration) @fn
(func_literal) @fn
(type_declaration) @class
(call_expression) @call
(import_declaration) @import

;; ── Variables ──
(var_declaration) @var
(const_declaration) @var

;; ── Writes ──
(assignment_statement) @write
(short_var_declaration) @write

;; ── Usage ──
(identifier) @usage
