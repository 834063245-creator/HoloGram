;; C# Structure Queries

(method_declaration) @fn
(constructor_declaration) @fn
(class_declaration) @class
(struct_declaration) @class
(interface_declaration) @interface
(enum_declaration) @class
(invocation_expression) @call
(object_creation_expression) @call
(using_directive) @import

;; ── Variables ──
(field_declaration) @var
(local_declaration_statement) @var

;; ── Writes ──
(assignment_expression) @write
(postfix_unary_expression) @write
(prefix_unary_expression) @write

;; ── Throws ──
(throw_statement) @throws
(throw_expression) @throws

;; ── Usage ──
(identifier) @usage
