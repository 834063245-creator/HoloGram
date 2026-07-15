;; Dart Structure Queries

(function_declaration) @fn
(method_declaration) @fn
(function_expression) @fn
(class_declaration) @class
(enum_declaration) @class
(mixin_declaration) @class
(selector) @call
(new_expression) @call
(import_statement) @import
(export_statement) @import

;; ── Variables ──
(declaration) @var

;; ── Writes ──
(assignment_expression) @write

;; ── Throws ──
(throw_expression) @throws

;; ── Usage ──
(identifier) @usage
