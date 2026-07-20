;; Swift Structure Queries

(function_declaration) @fn
(method_declaration) @fn
(class_declaration) @class
(struct_declaration) @class
(enum_declaration) @class
(protocol_declaration) @interface
(call_expression) @call
(constructor_expression) @call
(macro_invocation) @call
(navigation_expression) @call
(import_declaration) @import

;; ── Variables ──
(property_declaration) @var

;; ── Writes ──
(assignment) @write

;; ── Throws ──
(throw_statement) @throws

;; ── Usage ──
(identifier) @usage
