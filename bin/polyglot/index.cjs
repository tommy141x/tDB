"use strict";
const __vite__wasmUrl = require("path").join(__dirname, "polyglot_sql.wasm");
function analyze_query$1(sql, options_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.analyze_query(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function analyze_query_value$1(sql, options) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm$3.analyze_query_value(ptr0, len0, addHeapObject(options));
  return takeObject(ret);
}
function annotate_types$1(sql, dialect, schema_json) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(schema_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.annotate_types(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function annotate_types_value$1(sql, dialect, schema_json) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passStringToWasm0(schema_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm$3.annotate_types_value(ptr0, len0, ptr1, len1, ptr2, len2);
  return takeObject(ret);
}
function ast_add_where$1(ast_json, condition_json, use_or) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(condition_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.ast_add_where(retptr, ptr0, len0, ptr1, len1, use_or);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function ast_get_aggregate_functions$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_aggregate_functions(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_get_column_names$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_column_names(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_get_functions$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_functions(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_get_literals$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_literals(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_get_subqueries$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_subqueries(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_get_table_names$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_table_names(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_get_tables$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_tables(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_get_window_functions$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_get_window_functions(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_node_count$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_node_count(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_qualify_columns$1(ast_json, table_name) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(table_name, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.ast_qualify_columns(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function ast_qualify_tables$1(ast_json, options_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.ast_qualify_tables(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function ast_remove_where$1(ast_json) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_remove_where(retptr, ptr0, len0);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_rename_columns$1(ast_json, mapping_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(mapping_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.ast_rename_columns(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function ast_rename_tables$1(ast_json, mapping_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(mapping_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.ast_rename_tables(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function ast_rename_tables_with_options$1(ast_json, mapping_json, options_json) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(mapping_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.ast_rename_tables_with_options(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function ast_set_distinct$1(ast_json, distinct) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_set_distinct(retptr, ptr0, len0, distinct);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_set_limit$1(ast_json, limit) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_set_limit(retptr, ptr0, len0, limit);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_set_offset$1(ast_json, offset) {
  let deferred2_0;
  let deferred2_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm$3.ast_set_offset(retptr, ptr0, len0, offset);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred2_0 = r0;
    deferred2_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred2_0, deferred2_1, 1);
  }
}
function ast_set_order_by$1(ast_json, order_by_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(order_by_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.ast_set_order_by(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function diff_sql$1(source_sql, target_sql, dialect, delta_only, f, t) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(source_sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(target_sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.diff_sql(retptr, ptr0, len0, ptr1, len1, ptr2, len2, delta_only, f, t);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function format_sql$1(sql, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.format_sql(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function format_sql_value$1(sql, dialect) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm$3.format_sql_value(ptr0, len0, ptr1, len1);
  return takeObject(ret);
}
function format_sql_with_options$1(sql, dialect, options_json) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.format_sql_with_options(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function format_sql_with_options_value$1(sql, dialect, options) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm$3.format_sql_with_options_value(ptr0, len0, ptr1, len1, addHeapObject(options));
  return takeObject(ret);
}
function generate$2(ast_json, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(ast_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.generate(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function generate_data_type$1(data_type_json, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(data_type_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.generate_data_type(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function generate_data_type_value$1(data_type, dialect) {
  const ptr0 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm$3.generate_data_type_value(addHeapObject(data_type), ptr0, len0);
  return takeObject(ret);
}
function generate_value$1(ast, dialect) {
  const ptr0 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm$3.generate_value(addHeapObject(ast), ptr0, len0);
  return takeObject(ret);
}
function get_dialects$1() {
  let deferred1_0;
  let deferred1_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    wasm$3.get_dialects(retptr);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred1_0 = r0;
    deferred1_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred1_0, deferred1_1, 1);
  }
}
function get_dialects_value$1() {
  const ret = wasm$3.get_dialects_value();
  return takeObject(ret);
}
function lineage_sql$1(sql, column2, dialect, trim_selects) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(column2, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.lineage_sql(retptr, ptr0, len0, ptr1, len1, ptr2, len2, trim_selects);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function lineage_sql_at$1(sql, ordinal, dialect, trim_selects) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.lineage_sql_at(retptr, ptr0, len0, ordinal, ptr1, len1, trim_selects);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function lineage_sql_at_with_schema$1(sql, ordinal, schema_json, dialect, trim_selects) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(schema_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.lineage_sql_at_with_schema(retptr, ptr0, len0, ordinal, ptr1, len1, ptr2, len2, trim_selects);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function lineage_sql_with_schema$1(sql, column2, schema_json, dialect, trim_selects) {
  let deferred5_0;
  let deferred5_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(column2, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(schema_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len3 = WASM_VECTOR_LEN;
    wasm$3.lineage_sql_with_schema(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, trim_selects);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred5_0 = r0;
    deferred5_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred5_0, deferred5_1, 1);
  }
}
function openlineage_column_lineage$1(sql, options_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.openlineage_column_lineage(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function openlineage_job_event$1(sql, options_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.openlineage_job_event(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function openlineage_run_event$1(sql, options_json) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.openlineage_run_event(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function output_columns_sql$1(sql, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.output_columns_sql(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function output_columns_sql_with_schema$1(sql, schema_json, dialect) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(schema_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.output_columns_sql_with_schema(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function parse$2(sql, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.parse(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function parse_data_type$1(sql, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.parse_data_type(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function parse_data_type_value$1(sql, dialect) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm$3.parse_data_type_value(ptr0, len0, ptr1, len1);
  return takeObject(ret);
}
function parse_value$1(sql, dialect) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm$3.parse_value(ptr0, len0, ptr1, len1);
  return takeObject(ret);
}
function plan$2(sql, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.plan(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function source_tables$1(sql, column2, dialect) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(column2, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.source_tables(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function tokenize$2(sql, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.tokenize(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function tokenize_value$1(sql, dialect) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ret = wasm$3.tokenize_value(ptr0, len0, ptr1, len1);
  return takeObject(ret);
}
function transpile$2(sql, read_dialect, write_dialect) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(read_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(write_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.transpile(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function transpile_value$1(sql, read_dialect, write_dialect) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(read_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passStringToWasm0(write_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm$3.transpile_value(ptr0, len0, ptr1, len1, ptr2, len2);
  return takeObject(ret);
}
function transpile_with_options$1(sql, read_dialect, write_dialect, options_json) {
  let deferred5_0;
  let deferred5_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(read_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(write_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len3 = WASM_VECTOR_LEN;
    wasm$3.transpile_with_options(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred5_0 = r0;
    deferred5_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred5_0, deferred5_1, 1);
  }
}
function transpile_with_options_value$1(sql, read_dialect, write_dialect, options) {
  const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len0 = WASM_VECTOR_LEN;
  const ptr1 = passStringToWasm0(read_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  const ptr2 = passStringToWasm0(write_dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len2 = WASM_VECTOR_LEN;
  const ret = wasm$3.transpile_with_options_value(ptr0, len0, ptr1, len1, ptr2, len2, addHeapObject(options));
  return takeObject(ret);
}
function validate$2(sql, dialect) {
  let deferred3_0;
  let deferred3_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm$3.validate(retptr, ptr0, len0, ptr1, len1);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred3_0 = r0;
    deferred3_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred3_0, deferred3_1, 1);
  }
}
function validate_with_options$1(sql, dialect, options_json) {
  let deferred4_0;
  let deferred4_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    wasm$3.validate_with_options(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred4_0 = r0;
    deferred4_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred4_0, deferred4_1, 1);
  }
}
function validate_with_schema$1(sql, schema_json, dialect, options_json) {
  let deferred5_0;
  let deferred5_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    const ptr0 = passStringToWasm0(sql, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(schema_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(dialect, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(options_json, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
    const len3 = WASM_VECTOR_LEN;
    wasm$3.validate_with_schema(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred5_0 = r0;
    deferred5_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred5_0, deferred5_1, 1);
  }
}
function version$1() {
  let deferred1_0;
  let deferred1_1;
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    wasm$3.version(retptr);
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    deferred1_0 = r0;
    deferred1_1 = r1;
    return getStringFromWasm0(r0, r1);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
    wasm$3.__wbindgen_export4(deferred1_0, deferred1_1, 1);
  }
}
function wasm_compat_build$1(request) {
  try {
    const retptr = wasm$3.__wbindgen_add_to_stack_pointer(-16);
    wasm$3.wasm_compat_build(retptr, addHeapObject(request));
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
    if (r2) {
      throw takeObject(r1);
    }
    return takeObject(r0);
  } finally {
    wasm$3.__wbindgen_add_to_stack_pointer(16);
  }
}
function __wbg_Error_8c4e43fe74559d73(arg0, arg1) {
  const ret = Error(getStringFromWasm0(arg0, arg1));
  return addHeapObject(ret);
}
function __wbg_Number_04624de7d0e8332d(arg0) {
  const ret = Number(getObject(arg0));
  return ret;
}
function __wbg_String_8f0eb39a4a4c2f66(arg0, arg1) {
  const ret = String(getObject(arg1));
  const ptr1 = passStringToWasm0(ret, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
function __wbg___wbindgen_bigint_get_as_i64_8fcf4ce7f1ca72a2(arg0, arg1) {
  const v = getObject(arg1);
  const ret = typeof v === "bigint" ? v : void 0;
  getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
function __wbg___wbindgen_boolean_get_bbbb1c18aa2f5e25(arg0) {
  const v = getObject(arg0);
  const ret = typeof v === "boolean" ? v : void 0;
  return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
}
function __wbg___wbindgen_debug_string_0bc8482c6e3508ae(arg0, arg1) {
  const ret = debugString(getObject(arg1));
  const ptr1 = passStringToWasm0(ret, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
function __wbg___wbindgen_in_47fa6863be6f2f25(arg0, arg1) {
  const ret = getObject(arg0) in getObject(arg1);
  return ret;
}
function __wbg___wbindgen_is_bigint_31b12575b56f32fc(arg0) {
  const ret = typeof getObject(arg0) === "bigint";
  return ret;
}
function __wbg___wbindgen_is_function_0095a73b8b156f76(arg0) {
  const ret = typeof getObject(arg0) === "function";
  return ret;
}
function __wbg___wbindgen_is_object_5ae8e5880f2c1fbd(arg0) {
  const val = getObject(arg0);
  const ret = typeof val === "object" && val !== null;
  return ret;
}
function __wbg___wbindgen_is_string_cd444516edc5b180(arg0) {
  const ret = typeof getObject(arg0) === "string";
  return ret;
}
function __wbg___wbindgen_is_undefined_9e4d92534c42d778(arg0) {
  const ret = getObject(arg0) === void 0;
  return ret;
}
function __wbg___wbindgen_jsval_eq_11888390b0186270(arg0, arg1) {
  const ret = getObject(arg0) === getObject(arg1);
  return ret;
}
function __wbg___wbindgen_jsval_loose_eq_9dd77d8cd6671811(arg0, arg1) {
  const ret = getObject(arg0) == getObject(arg1);
  return ret;
}
function __wbg___wbindgen_number_get_8ff4255516ccad3e(arg0, arg1) {
  const obj = getObject(arg1);
  const ret = typeof obj === "number" ? obj : void 0;
  getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
function __wbg___wbindgen_string_get_72fb696202c56729(arg0, arg1) {
  const obj = getObject(arg1);
  const ret = typeof obj === "string" ? obj : void 0;
  var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  var len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
function __wbg___wbindgen_throw_be289d5034ed271b(arg0, arg1) {
  throw new Error(getStringFromWasm0(arg0, arg1));
}
function __wbg_call_389efe28435a9388() {
  return handleError(function(arg0, arg1) {
    const ret = getObject(arg0).call(getObject(arg1));
    return addHeapObject(ret);
  }, arguments);
}
function __wbg_done_57b39ecd9addfe81(arg0) {
  const ret = getObject(arg0).done;
  return ret;
}
function __wbg_entries_58c7934c745daac7(arg0) {
  const ret = Object.entries(getObject(arg0));
  return addHeapObject(ret);
}
function __wbg_error_7534b8e9a36f1ab4(arg0, arg1) {
  let deferred0_0;
  let deferred0_1;
  try {
    deferred0_0 = arg0;
    deferred0_1 = arg1;
    console.error(getStringFromWasm0(arg0, arg1));
  } finally {
    wasm$3.__wbindgen_export4(deferred0_0, deferred0_1, 1);
  }
}
function __wbg_fromCodePoint_22365db7b7d6ac39() {
  return handleError(function(arg0) {
    const ret = String.fromCodePoint(arg0 >>> 0);
    return addHeapObject(ret);
  }, arguments);
}
function __wbg_get_9b94d73e6221f75c(arg0, arg1) {
  const ret = getObject(arg0)[arg1 >>> 0];
  return addHeapObject(ret);
}
function __wbg_get_b3ed3ad4be2bc8ac() {
  return handleError(function(arg0, arg1) {
    const ret = Reflect.get(getObject(arg0), getObject(arg1));
    return addHeapObject(ret);
  }, arguments);
}
function __wbg_get_with_ref_key_1dc361bd10053bfe(arg0, arg1) {
  const ret = getObject(arg0)[getObject(arg1)];
  return addHeapObject(ret);
}
function __wbg_instanceof_ArrayBuffer_c367199e2fa2aa04(arg0) {
  let result;
  try {
    result = getObject(arg0) instanceof ArrayBuffer;
  } catch (_) {
    result = false;
  }
  const ret = result;
  return ret;
}
function __wbg_instanceof_Map_53af74335dec57f4(arg0) {
  let result;
  try {
    result = getObject(arg0) instanceof Map;
  } catch (_) {
    result = false;
  }
  const ret = result;
  return ret;
}
function __wbg_instanceof_Uint8Array_9b9075935c74707c(arg0) {
  let result;
  try {
    result = getObject(arg0) instanceof Uint8Array;
  } catch (_) {
    result = false;
  }
  const ret = result;
  return ret;
}
function __wbg_isArray_d314bb98fcf08331(arg0) {
  const ret = Array.isArray(getObject(arg0));
  return ret;
}
function __wbg_isSafeInteger_bfbc7332a9768d2a(arg0) {
  const ret = Number.isSafeInteger(getObject(arg0));
  return ret;
}
function __wbg_iterator_6ff6560ca1568e55() {
  const ret = Symbol.iterator;
  return addHeapObject(ret);
}
function __wbg_length_32ed9a279acd054c(arg0) {
  const ret = getObject(arg0).length;
  return ret;
}
function __wbg_length_35a7bace40f36eac(arg0) {
  const ret = getObject(arg0).length;
  return ret;
}
function __wbg_new_361308b2356cecd0() {
  const ret = new Object();
  return addHeapObject(ret);
}
function __wbg_new_3eb36ae241fe6f44() {
  const ret = new Array();
  return addHeapObject(ret);
}
function __wbg_new_8a6f238a6ece86ea() {
  const ret = new Error();
  return addHeapObject(ret);
}
function __wbg_new_dca287b076112a51() {
  const ret = /* @__PURE__ */ new Map();
  return addHeapObject(ret);
}
function __wbg_new_dd2b680c8bf6ae29(arg0) {
  const ret = new Uint8Array(getObject(arg0));
  return addHeapObject(ret);
}
function __wbg_next_3482f54c49e8af19() {
  return handleError(function(arg0) {
    const ret = getObject(arg0).next();
    return addHeapObject(ret);
  }, arguments);
}
function __wbg_next_418f80d8f5303233(arg0) {
  const ret = getObject(arg0).next;
  return addHeapObject(ret);
}
function __wbg_prototypesetcall_bdcdcc5842e4d77d(arg0, arg1, arg2) {
  Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
}
function __wbg_set_1eb0999cf5d27fc8(arg0, arg1, arg2) {
  const ret = getObject(arg0).set(getObject(arg1), getObject(arg2));
  return addHeapObject(ret);
}
function __wbg_set_3f1d0b984ed272ed(arg0, arg1, arg2) {
  getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
}
function __wbg_set_f43e577aea94465b(arg0, arg1, arg2) {
  getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
}
function __wbg_stack_0ed75d68575b0f3c(arg0, arg1) {
  const ret = getObject(arg1).stack;
  const ptr1 = passStringToWasm0(ret, wasm$3.__wbindgen_export, wasm$3.__wbindgen_export2);
  const len1 = WASM_VECTOR_LEN;
  getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
  getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
function __wbg_value_0546255b415e96c1(arg0) {
  const ret = getObject(arg0).value;
  return addHeapObject(ret);
}
function __wbindgen_cast_0000000000000001(arg0) {
  const ret = arg0;
  return addHeapObject(ret);
}
function __wbindgen_cast_0000000000000002(arg0) {
  const ret = arg0;
  return addHeapObject(ret);
}
function __wbindgen_cast_0000000000000003(arg0, arg1) {
  const ret = getStringFromWasm0(arg0, arg1);
  return addHeapObject(ret);
}
function __wbindgen_cast_0000000000000004(arg0) {
  const ret = BigInt.asUintN(64, arg0);
  return addHeapObject(ret);
}
function __wbindgen_object_clone_ref(arg0) {
  const ret = getObject(arg0);
  return addHeapObject(ret);
}
function __wbindgen_object_drop_ref(arg0) {
  takeObject(arg0);
}
function addHeapObject(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];
  heap[idx] = obj;
  return idx;
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length2 = val.length;
    let debug = "[";
    if (length2 > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length2; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
function dropObject(idx) {
  if (idx < 132) return;
  heap[idx] = heap_next;
  heap_next = idx;
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm$3.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm$3.memory.buffer);
  }
  return cachedDataViewMemory0;
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm$3.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function getObject(idx) {
  return heap[idx];
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    wasm$3.__wbindgen_export3(addHeapObject(e));
  }
}
let heap = new Array(128).fill(void 0);
heap.push(void 0, null, true, false);
let heap_next = heap.length;
function isLikeNone(x) {
  return x === void 0 || x === null;
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function takeObject(idx) {
  const ret = getObject(idx);
  dropObject(idx);
  return ret;
}
let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
const cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function(arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length
    };
  };
}
let WASM_VECTOR_LEN = 0;
let wasm$3;
function __wbg_set_wasm(val) {
  wasm$3 = val;
}
URL = globalThis.URL;
let __vite__wasmModule;
const __vite__wasmImports = { "./polyglot_sql_wasm_bg.js": {
  "__wbindgen_object_drop_ref": __wbindgen_object_drop_ref,
  "__wbindgen_object_clone_ref": __wbindgen_object_clone_ref,
  "__wbg_new_8a6f238a6ece86ea": __wbg_new_8a6f238a6ece86ea,
  "__wbg_stack_0ed75d68575b0f3c": __wbg_stack_0ed75d68575b0f3c,
  "__wbg_error_7534b8e9a36f1ab4": __wbg_error_7534b8e9a36f1ab4,
  "__wbg_set_3f1d0b984ed272ed": __wbg_set_3f1d0b984ed272ed,
  "__wbg_get_with_ref_key_1dc361bd10053bfe": __wbg_get_with_ref_key_1dc361bd10053bfe,
  "__wbg_String_8f0eb39a4a4c2f66": __wbg_String_8f0eb39a4a4c2f66,
  "__wbg_new_3eb36ae241fe6f44": __wbg_new_3eb36ae241fe6f44,
  "__wbg_get_9b94d73e6221f75c": __wbg_get_9b94d73e6221f75c,
  "__wbg_set_f43e577aea94465b": __wbg_set_f43e577aea94465b,
  "__wbg_isArray_d314bb98fcf08331": __wbg_isArray_d314bb98fcf08331,
  "__wbg_length_35a7bace40f36eac": __wbg_length_35a7bace40f36eac,
  "__wbg_call_389efe28435a9388": __wbg_call_389efe28435a9388,
  "__wbg_new_dca287b076112a51": __wbg_new_dca287b076112a51,
  "__wbg_set_1eb0999cf5d27fc8": __wbg_set_1eb0999cf5d27fc8,
  "__wbg_isSafeInteger_bfbc7332a9768d2a": __wbg_isSafeInteger_bfbc7332a9768d2a,
  "__wbg_next_3482f54c49e8af19": __wbg_next_3482f54c49e8af19,
  "__wbg_done_57b39ecd9addfe81": __wbg_done_57b39ecd9addfe81,
  "__wbg_value_0546255b415e96c1": __wbg_value_0546255b415e96c1,
  "__wbg_entries_58c7934c745daac7": __wbg_entries_58c7934c745daac7,
  "__wbg_new_361308b2356cecd0": __wbg_new_361308b2356cecd0,
  "__wbg_fromCodePoint_22365db7b7d6ac39": __wbg_fromCodePoint_22365db7b7d6ac39,
  "__wbg_iterator_6ff6560ca1568e55": __wbg_iterator_6ff6560ca1568e55,
  "__wbg_prototypesetcall_bdcdcc5842e4d77d": __wbg_prototypesetcall_bdcdcc5842e4d77d,
  "__wbg_new_dd2b680c8bf6ae29": __wbg_new_dd2b680c8bf6ae29,
  "__wbg_length_32ed9a279acd054c": __wbg_length_32ed9a279acd054c,
  "__wbg_next_418f80d8f5303233": __wbg_next_418f80d8f5303233,
  "__wbg_get_b3ed3ad4be2bc8ac": __wbg_get_b3ed3ad4be2bc8ac,
  "__wbg_instanceof_Map_53af74335dec57f4": __wbg_instanceof_Map_53af74335dec57f4,
  "__wbg_instanceof_Uint8Array_9b9075935c74707c": __wbg_instanceof_Uint8Array_9b9075935c74707c,
  "__wbg_instanceof_ArrayBuffer_c367199e2fa2aa04": __wbg_instanceof_ArrayBuffer_c367199e2fa2aa04,
  "__wbg___wbindgen_in_47fa6863be6f2f25": __wbg___wbindgen_in_47fa6863be6f2f25,
  "__wbg___wbindgen_throw_be289d5034ed271b": __wbg___wbindgen_throw_be289d5034ed271b,
  "__wbg___wbindgen_jsval_eq_11888390b0186270": __wbg___wbindgen_jsval_eq_11888390b0186270,
  "__wbg_Number_04624de7d0e8332d": __wbg_Number_04624de7d0e8332d,
  "__wbg_Error_8c4e43fe74559d73": __wbg_Error_8c4e43fe74559d73,
  "__wbg___wbindgen_is_bigint_31b12575b56f32fc": __wbg___wbindgen_is_bigint_31b12575b56f32fc,
  "__wbg___wbindgen_is_object_5ae8e5880f2c1fbd": __wbg___wbindgen_is_object_5ae8e5880f2c1fbd,
  "__wbg___wbindgen_is_string_cd444516edc5b180": __wbg___wbindgen_is_string_cd444516edc5b180,
  "__wbg___wbindgen_number_get_8ff4255516ccad3e": __wbg___wbindgen_number_get_8ff4255516ccad3e,
  "__wbg___wbindgen_string_get_72fb696202c56729": __wbg___wbindgen_string_get_72fb696202c56729,
  "__wbg___wbindgen_boolean_get_bbbb1c18aa2f5e25": __wbg___wbindgen_boolean_get_bbbb1c18aa2f5e25,
  "__wbg___wbindgen_is_function_0095a73b8b156f76": __wbg___wbindgen_is_function_0095a73b8b156f76,
  "__wbg___wbindgen_is_undefined_9e4d92534c42d778": __wbg___wbindgen_is_undefined_9e4d92534c42d778,
  "__wbg___wbindgen_jsval_loose_eq_9dd77d8cd6671811": __wbg___wbindgen_jsval_loose_eq_9dd77d8cd6671811,
  "__wbg___wbindgen_bigint_get_as_i64_8fcf4ce7f1ca72a2": __wbg___wbindgen_bigint_get_as_i64_8fcf4ce7f1ca72a2,
  "__wbg___wbindgen_debug_string_0bc8482c6e3508ae": __wbg___wbindgen_debug_string_0bc8482c6e3508ae,
  "__wbindgen_cast_0000000000000001": __wbindgen_cast_0000000000000001,
  "__wbindgen_cast_0000000000000002": __wbindgen_cast_0000000000000002,
  "__wbindgen_cast_0000000000000003": __wbindgen_cast_0000000000000003,
  "__wbindgen_cast_0000000000000004": __wbindgen_cast_0000000000000004
} };
let __initPromise;
async function __polyglot_init_wasm() {
  if (__vite__wasmModule) return;
  if (__initPromise) return __initPromise;
  __initPromise = (async () => {
    const wasmPath = require("path").join(__dirname, "polyglot_sql.wasm");
    const bytes = require("fs").readFileSync(wasmPath);
    const result = await WebAssembly.instantiate(bytes, __vite__wasmImports);
    __vite__wasmModule = result.instance.exports;
  memory = __vite__wasmModule.memory;
  analyze_query = __vite__wasmModule.analyze_query;
  analyze_query_value = __vite__wasmModule.analyze_query_value;
  annotate_types = __vite__wasmModule.annotate_types;
  annotate_types_value = __vite__wasmModule.annotate_types_value;
  ast_add_where = __vite__wasmModule.ast_add_where;
  ast_get_aggregate_functions = __vite__wasmModule.ast_get_aggregate_functions;
  ast_get_column_names = __vite__wasmModule.ast_get_column_names;
  ast_get_functions = __vite__wasmModule.ast_get_functions;
  ast_get_literals = __vite__wasmModule.ast_get_literals;
  ast_get_subqueries = __vite__wasmModule.ast_get_subqueries;
  ast_get_table_names = __vite__wasmModule.ast_get_table_names;
  ast_get_tables = __vite__wasmModule.ast_get_tables;
  ast_get_window_functions = __vite__wasmModule.ast_get_window_functions;
  ast_node_count = __vite__wasmModule.ast_node_count;
  ast_qualify_columns = __vite__wasmModule.ast_qualify_columns;
  ast_qualify_tables = __vite__wasmModule.ast_qualify_tables;
  ast_remove_where = __vite__wasmModule.ast_remove_where;
  ast_rename_columns = __vite__wasmModule.ast_rename_columns;
  ast_rename_tables = __vite__wasmModule.ast_rename_tables;
  ast_rename_tables_with_options = __vite__wasmModule.ast_rename_tables_with_options;
  ast_set_distinct = __vite__wasmModule.ast_set_distinct;
  ast_set_limit = __vite__wasmModule.ast_set_limit;
  ast_set_offset = __vite__wasmModule.ast_set_offset;
  ast_set_order_by = __vite__wasmModule.ast_set_order_by;
  diff_sql = __vite__wasmModule.diff_sql;
  format_sql = __vite__wasmModule.format_sql;
  format_sql_value = __vite__wasmModule.format_sql_value;
  format_sql_with_options = __vite__wasmModule.format_sql_with_options;
  format_sql_with_options_value = __vite__wasmModule.format_sql_with_options_value;
  generate$1 = __vite__wasmModule.generate;
  generate_data_type = __vite__wasmModule.generate_data_type;
  generate_data_type_value = __vite__wasmModule.generate_data_type_value;
  generate_value = __vite__wasmModule.generate_value;
  get_dialects = __vite__wasmModule.get_dialects;
  get_dialects_value = __vite__wasmModule.get_dialects_value;
  lineage_sql = __vite__wasmModule.lineage_sql;
  lineage_sql_at = __vite__wasmModule.lineage_sql_at;
  lineage_sql_at_with_schema = __vite__wasmModule.lineage_sql_at_with_schema;
  lineage_sql_with_schema = __vite__wasmModule.lineage_sql_with_schema;
  openlineage_column_lineage = __vite__wasmModule.openlineage_column_lineage;
  openlineage_job_event = __vite__wasmModule.openlineage_job_event;
  openlineage_run_event = __vite__wasmModule.openlineage_run_event;
  output_columns_sql = __vite__wasmModule.output_columns_sql;
  output_columns_sql_with_schema = __vite__wasmModule.output_columns_sql_with_schema;
  parse$1 = __vite__wasmModule.parse;
  parse_data_type = __vite__wasmModule.parse_data_type;
  parse_data_type_value = __vite__wasmModule.parse_data_type_value;
  parse_value = __vite__wasmModule.parse_value;
  plan$1 = __vite__wasmModule.plan;
  source_tables = __vite__wasmModule.source_tables;
  tokenize$1 = __vite__wasmModule.tokenize;
  tokenize_value = __vite__wasmModule.tokenize_value;
  transpile$1 = __vite__wasmModule.transpile;
  transpile_value = __vite__wasmModule.transpile_value;
  transpile_with_options = __vite__wasmModule.transpile_with_options;
  transpile_with_options_value = __vite__wasmModule.transpile_with_options_value;
  validate$1 = __vite__wasmModule.validate;
  validate_with_options = __vite__wasmModule.validate_with_options;
  validate_with_schema = __vite__wasmModule.validate_with_schema;
  version = __vite__wasmModule.version;
  wasm_compat_build = __vite__wasmModule.wasm_compat_build;
  __wbindgen_export = __vite__wasmModule.__wbindgen_export;
  __wbindgen_export2 = __vite__wasmModule.__wbindgen_export2;
  __wbindgen_export3 = __vite__wasmModule.__wbindgen_export3;
  __wbindgen_export4 = __vite__wasmModule.__wbindgen_export4;
  __wbindgen_add_to_stack_pointer = __vite__wasmModule.__wbindgen_add_to_stack_pointer;
    __wbg_set_wasm(__vite__wasmModule);
  })();
  return __initPromise;
}
let memory;
let analyze_query;
let analyze_query_value;
let annotate_types;
let annotate_types_value;
let ast_add_where;
let ast_get_aggregate_functions;
let ast_get_column_names;
let ast_get_functions;
let ast_get_literals;
let ast_get_subqueries;
let ast_get_table_names;
let ast_get_tables;
let ast_get_window_functions;
let ast_node_count;
let ast_qualify_columns;
let ast_qualify_tables;
let ast_remove_where;
let ast_rename_columns;
let ast_rename_tables;
let ast_rename_tables_with_options;
let ast_set_distinct;
let ast_set_limit;
let ast_set_offset;
let ast_set_order_by;
let diff_sql;
let format_sql;
let format_sql_value;
let format_sql_with_options;
let format_sql_with_options_value;
let generate$1;
let generate_data_type;
let generate_data_type_value;
let generate_value;
let get_dialects;
let get_dialects_value;
let lineage_sql;
let lineage_sql_at;
let lineage_sql_at_with_schema;
let lineage_sql_with_schema;
let openlineage_column_lineage;
let openlineage_job_event;
let openlineage_run_event;
let output_columns_sql;
let output_columns_sql_with_schema;
let parse$1;
let parse_data_type;
let parse_data_type_value;
let parse_value;
let plan$1;
let source_tables;
let tokenize$1;
let tokenize_value;
let transpile$1;
let transpile_value;
let transpile_with_options;
let transpile_with_options_value;
let validate$1;
let validate_with_options;
let validate_with_schema;
let version;
let wasm_compat_build;
let __wbindgen_export;
let __wbindgen_export2;
let __wbindgen_export3;
let __wbindgen_export4;
let __wbindgen_add_to_stack_pointer;
const wasm$2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  __wbindgen_add_to_stack_pointer,
  __wbindgen_export,
  __wbindgen_export2,
  __wbindgen_export3,
  __wbindgen_export4,
  analyze_query,
  analyze_query_value,
  annotate_types,
  annotate_types_value,
  ast_add_where,
  ast_get_aggregate_functions,
  ast_get_column_names,
  ast_get_functions,
  ast_get_literals,
  ast_get_subqueries,
  ast_get_table_names,
  ast_get_tables,
  ast_get_window_functions,
  ast_node_count,
  ast_qualify_columns,
  ast_qualify_tables,
  ast_remove_where,
  ast_rename_columns,
  ast_rename_tables,
  ast_rename_tables_with_options,
  ast_set_distinct,
  ast_set_limit,
  ast_set_offset,
  ast_set_order_by,
  diff_sql,
  format_sql,
  format_sql_value,
  format_sql_with_options,
  format_sql_with_options_value,
  generate: generate$1,
  generate_data_type,
  generate_data_type_value,
  generate_value,
  get_dialects,
  get_dialects_value,
  lineage_sql,
  lineage_sql_at,
  lineage_sql_at_with_schema,
  lineage_sql_with_schema,
  memory,
  openlineage_column_lineage,
  openlineage_job_event,
  openlineage_run_event,
  output_columns_sql,
  output_columns_sql_with_schema,
  parse: parse$1,
  parse_data_type,
  parse_data_type_value,
  parse_value,
  plan: plan$1,
  source_tables,
  tokenize: tokenize$1,
  tokenize_value,
  transpile: transpile$1,
  transpile_value,
  transpile_with_options,
  transpile_with_options_value,
  validate: validate$1,
  validate_with_options,
  validate_with_schema,
  version,
  wasm_compat_build
}, Symbol.toStringTag, { value: "Module" }));
const wasmModule = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  analyze_query: analyze_query$1,
  analyze_query_value: analyze_query_value$1,
  annotate_types: annotate_types$1,
  annotate_types_value: annotate_types_value$1,
  ast_add_where: ast_add_where$1,
  ast_get_aggregate_functions: ast_get_aggregate_functions$1,
  ast_get_column_names: ast_get_column_names$1,
  ast_get_functions: ast_get_functions$1,
  ast_get_literals: ast_get_literals$1,
  ast_get_subqueries: ast_get_subqueries$1,
  ast_get_table_names: ast_get_table_names$1,
  ast_get_tables: ast_get_tables$1,
  ast_get_window_functions: ast_get_window_functions$1,
  ast_node_count: ast_node_count$1,
  ast_qualify_columns: ast_qualify_columns$1,
  ast_qualify_tables: ast_qualify_tables$1,
  ast_remove_where: ast_remove_where$1,
  ast_rename_columns: ast_rename_columns$1,
  ast_rename_tables: ast_rename_tables$1,
  ast_rename_tables_with_options: ast_rename_tables_with_options$1,
  ast_set_distinct: ast_set_distinct$1,
  ast_set_limit: ast_set_limit$1,
  ast_set_offset: ast_set_offset$1,
  ast_set_order_by: ast_set_order_by$1,
  diff_sql: diff_sql$1,
  format_sql: format_sql$1,
  format_sql_value: format_sql_value$1,
  format_sql_with_options: format_sql_with_options$1,
  format_sql_with_options_value: format_sql_with_options_value$1,
  generate: generate$2,
  generate_data_type: generate_data_type$1,
  generate_data_type_value: generate_data_type_value$1,
  generate_value: generate_value$1,
  get_dialects: get_dialects$1,
  get_dialects_value: get_dialects_value$1,
  lineage_sql: lineage_sql$1,
  lineage_sql_at: lineage_sql_at$1,
  lineage_sql_at_with_schema: lineage_sql_at_with_schema$1,
  lineage_sql_with_schema: lineage_sql_with_schema$1,
  openlineage_column_lineage: openlineage_column_lineage$1,
  openlineage_job_event: openlineage_job_event$1,
  openlineage_run_event: openlineage_run_event$1,
  output_columns_sql: output_columns_sql$1,
  output_columns_sql_with_schema: output_columns_sql_with_schema$1,
  parse: parse$2,
  parse_data_type: parse_data_type$1,
  parse_data_type_value: parse_data_type_value$1,
  parse_value: parse_value$1,
  plan: plan$2,
  source_tables: source_tables$1,
  tokenize: tokenize$2,
  tokenize_value: tokenize_value$1,
  transpile: transpile$2,
  transpile_value: transpile_value$1,
  transpile_with_options: transpile_with_options$1,
  transpile_with_options_value: transpile_with_options_value$1,
  validate: validate$2,
  validate_with_options: validate_with_options$1,
  validate_with_schema: validate_with_schema$1,
  version: version$1,
  wasm_compat_build: wasm_compat_build$1
}, Symbol.toStringTag, { value: "Module" }));
const EXPRESSION_VARIANT_NAMES = [
  "literal",
  "boolean",
  "null",
  "identifier",
  "column",
  "table",
  "star",
  "braced_wildcard",
  "select",
  "union",
  "intersect",
  "except",
  "subquery",
  "pipe_operator",
  "pivot",
  "pivot_alias",
  "unpivot",
  "values",
  "pre_where",
  "stream",
  "using_data",
  "xml_namespace",
  "insert",
  "update",
  "delete",
  "copy",
  "put",
  "stage_reference",
  "try_catch",
  "alias",
  "cast",
  "collation",
  "case",
  "and",
  "or",
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "like",
  "i_like",
  "match",
  "bitwise_and",
  "bitwise_or",
  "bitwise_xor",
  "concat",
  "adjacent",
  "ts_match",
  "property_e_q",
  "array_contains_all",
  "array_contained_by",
  "array_overlaps",
  "j_s_o_n_b_contains_all_top_keys",
  "j_s_o_n_b_contains_any_top_keys",
  "j_s_o_n_b_delete_at_path",
  "extends_left",
  "extends_right",
  "not",
  "neg",
  "bitwise_not",
  "in",
  "between",
  "is_null",
  "is_true",
  "is_false",
  "is_json",
  "is",
  "exists",
  "member_of",
  "function",
  "aggregate_function",
  "window_function",
  "from",
  "join",
  "joined_table",
  "where",
  "group_by",
  "having",
  "order_by",
  "limit",
  "offset",
  "qualify",
  "with",
  "cte",
  "distribute_by",
  "cluster_by",
  "sort_by",
  "lateral_view",
  "hint",
  "pseudocolumn",
  "connect",
  "prior",
  "connect_by_root",
  "match_recognize",
  "ordered",
  "window",
  "over",
  "within_group",
  "data_type",
  "array",
  "struct",
  "tuple",
  "interval",
  "concat_ws",
  "substring",
  "upper",
  "lower",
  "length",
  "trim",
  "l_trim",
  "r_trim",
  "replace",
  "reverse",
  "left",
  "right",
  "repeat",
  "lpad",
  "rpad",
  "split",
  "regexp_like",
  "regexp_replace",
  "regexp_extract",
  "overlay",
  "abs",
  "round",
  "floor",
  "ceil",
  "power",
  "sqrt",
  "cbrt",
  "ln",
  "log",
  "exp",
  "sign",
  "greatest",
  "least",
  "current_date",
  "current_time",
  "current_timestamp",
  "current_timestamp_l_t_z",
  "at_time_zone",
  "date_add",
  "date_sub",
  "date_diff",
  "date_trunc",
  "extract",
  "to_date",
  "to_timestamp",
  "date",
  "time",
  "date_from_unix_date",
  "unix_date",
  "unix_seconds",
  "unix_millis",
  "unix_micros",
  "unix_to_time_str",
  "time_str_to_date",
  "date_to_di",
  "di_to_date",
  "ts_or_di_to_di",
  "ts_or_ds_to_datetime",
  "ts_or_ds_to_timestamp",
  "year_of_week",
  "year_of_week_iso",
  "coalesce",
  "null_if",
  "if_func",
  "if_null",
  "nvl",
  "nvl2",
  "try_cast",
  "safe_cast",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "group_concat",
  "string_agg",
  "list_agg",
  "array_agg",
  "count_if",
  "sum_if",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "variance",
  "var_pop",
  "var_samp",
  "median",
  "mode",
  "first",
  "last",
  "any_value",
  "approx_distinct",
  "approx_count_distinct",
  "approx_percentile",
  "percentile",
  "logical_and",
  "logical_or",
  "skewness",
  "bitwise_count",
  "array_concat_agg",
  "array_unique_agg",
  "bool_xor_agg",
  "row_number",
  "rank",
  "dense_rank",
  "n_tile",
  "lead",
  "lag",
  "first_value",
  "last_value",
  "nth_value",
  "percent_rank",
  "cume_dist",
  "percentile_cont",
  "percentile_disc",
  "contains",
  "starts_with",
  "ends_with",
  "position",
  "initcap",
  "ascii",
  "chr",
  "char_func",
  "soundex",
  "levenshtein",
  "byte_length",
  "hex",
  "lower_hex",
  "unicode",
  "mod_func",
  "random",
  "rand",
  "trunc_func",
  "pi",
  "radians",
  "degrees",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "is_nan",
  "is_inf",
  "int_div",
  "decode",
  "date_format",
  "format_date",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "day_of_week",
  "day_of_week_iso",
  "day_of_month",
  "day_of_year",
  "week_of_year",
  "quarter",
  "add_months",
  "months_between",
  "last_day",
  "next_day",
  "epoch",
  "epoch_ms",
  "from_unixtime",
  "unix_timestamp",
  "make_date",
  "make_timestamp",
  "timestamp_trunc",
  "time_str_to_unix",
  "session_user",
  "s_h_a",
  "s_h_a1_digest",
  "time_to_unix",
  "array_func",
  "array_length",
  "array_size",
  "cardinality",
  "array_contains",
  "array_position",
  "array_append",
  "array_prepend",
  "array_concat",
  "array_sort",
  "array_reverse",
  "array_distinct",
  "array_join",
  "array_to_string",
  "unnest",
  "explode",
  "explode_outer",
  "array_filter",
  "array_transform",
  "array_flatten",
  "array_compact",
  "array_intersect",
  "array_union",
  "array_except",
  "array_remove",
  "array_zip",
  "sequence",
  "generate",
  "exploding_generate_series",
  "to_array",
  "star_map",
  "struct_func",
  "struct_extract",
  "named_struct",
  "map_func",
  "map_from_entries",
  "map_from_arrays",
  "map_keys",
  "map_values",
  "map_contains_key",
  "map_concat",
  "element_at",
  "transform_keys",
  "transform_values",
  "function_emits",
  "json_extract",
  "json_extract_scalar",
  "json_extract_path",
  "json_array",
  "json_object",
  "json_query",
  "json_value",
  "json_array_length",
  "json_keys",
  "json_type",
  "parse_json",
  "to_json",
  "json_set",
  "json_insert",
  "json_remove",
  "json_merge_patch",
  "json_array_agg",
  "json_object_agg",
  "convert",
  "typeof",
  "lambda",
  "parameter",
  "placeholder",
  "named_argument",
  "table_argument",
  "sql_comment",
  "null_safe_eq",
  "null_safe_neq",
  "glob",
  "similar_to",
  "any",
  "all",
  "overlaps",
  "bitwise_left_shift",
  "bitwise_right_shift",
  "bitwise_and_agg",
  "bitwise_or_agg",
  "bitwise_xor_agg",
  "subscript",
  "dot",
  "method_call",
  "array_slice",
  "create_table",
  "drop_table",
  "undrop",
  "alter_table",
  "split_table",
  "flashback_table",
  "create_index",
  "drop_index",
  "create_view",
  "drop_view",
  "alter_view",
  "alter_index",
  "truncate",
  "use",
  "cache",
  "uncache",
  "load_data",
  "pragma",
  "grant",
  "revoke",
  "comment",
  "set_statement",
  "create_schema",
  "drop_schema",
  "drop_namespace",
  "create_database",
  "drop_database",
  "create_function",
  "drop_function",
  "create_procedure",
  "drop_procedure",
  "create_sequence",
  "create_synonym",
  "drop_sequence",
  "alter_sequence",
  "create_trigger",
  "drop_trigger",
  "create_type",
  "drop_type",
  "describe",
  "show",
  "command",
  "kill",
  "prepare",
  "execute",
  "create_task",
  "raw",
  "paren",
  "annotated",
  "refresh",
  "locking_statement",
  "sequence_properties",
  "truncate_table",
  "clone",
  "attach",
  "detach",
  "install",
  "summarize",
  "declare",
  "declare_item",
  "set",
  "heredoc",
  "set_item",
  "query_band",
  "user_defined_function",
  "recursive_with_search",
  "projection_def",
  "table_alias",
  "byte_string",
  "hex_string_expr",
  "unicode_string",
  "column_position",
  "column_def",
  "alter_column",
  "alter_sort_key",
  "alter_set",
  "rename_column",
  "comprehension",
  "merge_tree_t_t_l_action",
  "merge_tree_t_t_l",
  "index_constraint_option",
  "column_constraint",
  "period_for_system_time_constraint",
  "case_specific_column_constraint",
  "character_set_column_constraint",
  "check_column_constraint",
  "assume_column_constraint",
  "compress_column_constraint",
  "date_format_column_constraint",
  "ephemeral_column_constraint",
  "with_operator",
  "generated_as_identity_column_constraint",
  "auto_increment_column_constraint",
  "comment_column_constraint",
  "generated_as_row_column_constraint",
  "index_column_constraint",
  "masking_policy_column_constraint",
  "not_null_column_constraint",
  "primary_key_column_constraint",
  "unique_column_constraint",
  "watermark_column_constraint",
  "computed_column_constraint",
  "in_out_column_constraint",
  "default_column_constraint",
  "path_column_constraint",
  "constraint",
  "export",
  "filter",
  "changes",
  "copy_parameter",
  "credentials",
  "directory",
  "foreign_key",
  "column_prefix",
  "primary_key",
  "into_clause",
  "join_hint",
  "opclass",
  "index",
  "index_parameters",
  "conditional_insert",
  "multitable_inserts",
  "on_conflict",
  "on_condition",
  "returning",
  "introducer",
  "partition_range",
  "fetch",
  "group",
  "cube",
  "rollup",
  "grouping_sets",
  "limit_options",
  "lateral",
  "table_from_rows",
  "rows_from",
  "match_recognize_measure",
  "with_fill",
  "property",
  "grant_privilege",
  "grant_principal",
  "allowed_values_property",
  "algorithm_property",
  "auto_increment_property",
  "auto_refresh_property",
  "backup_property",
  "build_property",
  "block_compression_property",
  "character_set_property",
  "checksum_property",
  "collate_property",
  "data_blocksize_property",
  "data_deletion_property",
  "definer_property",
  "dist_key_property",
  "distributed_by_property",
  "dist_style_property",
  "duplicate_key_property",
  "engine_property",
  "to_table_property",
  "execute_as_property",
  "external_property",
  "fallback_property",
  "file_format_property",
  "credentials_property",
  "freespace_property",
  "inherits_property",
  "input_model_property",
  "output_model_property",
  "isolated_loading_property",
  "journal_property",
  "language_property",
  "enviroment_property",
  "clustered_by_property",
  "dict_property",
  "dict_range",
  "on_cluster",
  "like_property",
  "location_property",
  "lock_property",
  "locking_property",
  "log_property",
  "materialized_property",
  "merge_block_ratio_property",
  "on_property",
  "on_commit_property",
  "partitioned_by_property",
  "partition_by_property",
  "partitioned_by_bucket",
  "cluster_by_columns_property",
  "partition_by_truncate",
  "partition_by_range_property",
  "partition_by_range_property_dynamic",
  "partition_by_list_property",
  "partition_list",
  "partition",
  "refresh_trigger_property",
  "unique_key_property",
  "rollup_property",
  "partition_bound_spec",
  "partitioned_of_property",
  "remote_with_connection_model_property",
  "returns_property",
  "row_format_property",
  "row_format_delimited_property",
  "row_format_serde_property",
  "query_transform",
  "sample_property",
  "security_property",
  "schema_comment_property",
  "semantic_view",
  "serde_properties",
  "set_property",
  "sharing_property",
  "set_config_property",
  "settings_property",
  "sort_key_property",
  "sql_read_write_property",
  "sql_security_property",
  "stability_property",
  "storage_handler_property",
  "temporary_property",
  "tags",
  "transform_model_property",
  "transient_property",
  "using_template_property",
  "view_attribute_property",
  "volatile_property",
  "with_data_property",
  "with_journal_table_property",
  "with_schema_binding_property",
  "with_system_versioning_property",
  "with_procedure_options",
  "encode_property",
  "include_property",
  "properties",
  "options_property",
  "input_output_format",
  "reference",
  "query_option",
  "with_table_hint",
  "index_table_hint",
  "historical_data",
  "get",
  "set_operation",
  "var",
  "variadic",
  "version",
  "schema",
  "lock",
  "table_sample",
  "tag",
  "unpivot_columns",
  "window_spec",
  "session_parameter",
  "pseudo_type",
  "object_identifier",
  "transaction",
  "commit",
  "rollback",
  "alter_session",
  "analyze",
  "analyze_statistics",
  "analyze_histogram",
  "analyze_sample",
  "analyze_list_chained_rows",
  "analyze_delete",
  "analyze_with",
  "analyze_validate",
  "add_partition",
  "attach_option",
  "drop_partition",
  "replace_partition",
  "d_pipe",
  "operator",
  "pivot_any",
  "aliases",
  "at_index",
  "from_time_zone",
  "format_phrase",
  "for_in",
  "time_unit",
  "interval_op",
  "interval_span",
  "having_max",
  "cosine_distance",
  "dot_product",
  "euclidean_distance",
  "manhattan_distance",
  "jarowinkler_similarity",
  "booland",
  "boolor",
  "parameterized_agg",
  "arg_max",
  "arg_min",
  "approx_top_k",
  "approx_top_k_accumulate",
  "approx_top_k_combine",
  "approx_top_k_estimate",
  "approx_top_sum",
  "approx_quantiles",
  "minhash",
  "farm_fingerprint",
  "float64",
  "transform",
  "translate",
  "grouping",
  "grouping_id",
  "anonymous",
  "anonymous_agg_func",
  "combined_agg_func",
  "combined_parameterized_agg",
  "hash_agg",
  "hll",
  "apply",
  "to_boolean",
  "list",
  "to_map",
  "pad",
  "to_char",
  "to_number",
  "to_double",
  "int64",
  "string_func",
  "to_decfloat",
  "try_to_decfloat",
  "to_file",
  "columns",
  "convert_to_charset",
  "convert_timezone",
  "generate_series",
  "a_i_agg",
  "a_i_classify",
  "array_all",
  "array_any",
  "array_construct_compact",
  "st_point",
  "st_distance",
  "string_to_array",
  "array_sum",
  "object_agg",
  "cast_to_str_type",
  "check_json",
  "check_xml",
  "translate_characters",
  "current_schemas",
  "current_datetime",
  "localtime",
  "localtimestamp",
  "systimestamp",
  "current_schema",
  "current_user",
  "utc_time",
  "utc_timestamp",
  "timestamp",
  "date_bin",
  "datetime",
  "datetime_add",
  "datetime_sub",
  "datetime_diff",
  "datetime_trunc",
  "dayname",
  "make_interval",
  "previous_day",
  "elt",
  "timestamp_add",
  "timestamp_sub",
  "timestamp_diff",
  "time_slice",
  "time_add",
  "time_sub",
  "time_diff",
  "time_trunc",
  "date_from_parts",
  "time_from_parts",
  "decode_case",
  "decrypt",
  "decrypt_raw",
  "encode",
  "encrypt",
  "encrypt_raw",
  "equal_null",
  "to_binary",
  "base64_decode_binary",
  "base64_decode_string",
  "base64_encode",
  "try_base64_decode_binary",
  "try_base64_decode_string",
  "gap_fill",
  "generate_date_array",
  "generate_timestamp_array",
  "get_extract",
  "getbit",
  "overflow_truncate_behavior",
  "hex_encode",
  "compress",
  "decompress_binary",
  "decompress_string",
  "xor",
  "nullif",
  "j_s_o_n",
  "j_s_o_n_path",
  "j_s_o_n_path_filter",
  "j_s_o_n_path_key",
  "j_s_o_n_path_recursive",
  "j_s_o_n_path_script",
  "j_s_o_n_path_slice",
  "j_s_o_n_path_selector",
  "j_s_o_n_path_subscript",
  "j_s_o_n_path_union",
  "format",
  "j_s_o_n_keys",
  "j_s_o_n_key_value",
  "j_s_o_n_keys_at_depth",
  "j_s_o_n_object",
  "j_s_o_n_object_agg",
  "j_s_o_n_b_object_agg",
  "j_s_o_n_array",
  "j_s_o_n_array_agg",
  "j_s_o_n_exists",
  "j_s_o_n_column_def",
  "j_s_o_n_schema",
  "j_s_o_n_set",
  "j_s_o_n_strip_nulls",
  "j_s_o_n_value",
  "j_s_o_n_value_array",
  "j_s_o_n_remove",
  "j_s_o_n_table",
  "j_s_o_n_type",
  "object_insert",
  "open_j_s_o_n_column_def",
  "open_j_s_o_n",
  "j_s_o_n_b_exists",
  "j_s_o_n_b_contains",
  "j_s_o_n_b_extract",
  "j_s_o_n_cast",
  "j_s_o_n_extract",
  "j_s_o_n_extract_quote",
  "j_s_o_n_extract_array",
  "j_s_o_n_extract_scalar",
  "j_s_o_n_b_extract_scalar",
  "j_s_o_n_format",
  "j_s_o_n_bool",
  "j_s_o_n_path_root",
  "j_s_o_n_array_append",
  "j_s_o_n_array_contains",
  "j_s_o_n_array_insert",
  "parse_j_s_o_n",
  "parse_url",
  "parse_ip",
  "parse_time",
  "parse_datetime",
  "map",
  "map_cat",
  "map_delete",
  "map_insert",
  "map_pick",
  "scope_resolution",
  "slice",
  "var_map",
  "match_against",
  "m_d5_digest",
  "m_d5_number_lower64",
  "m_d5_number_upper64",
  "monthname",
  "ntile",
  "normalize",
  "normal",
  "predict",
  "m_l_translate",
  "features_at_time",
  "generate_embedding",
  "m_l_forecast",
  "model_attribute",
  "vector_search",
  "quantile",
  "approx_quantile",
  "approx_percentile_estimate",
  "randn",
  "randstr",
  "range_n",
  "range_bucket",
  "read_c_s_v",
  "read_parquet",
  "reduce",
  "regexp_extract_all",
  "regexp_i_like",
  "regexp_full_match",
  "regexp_instr",
  "regexp_split",
  "regexp_count",
  "regr_valx",
  "regr_valy",
  "regr_avgy",
  "regr_avgx",
  "regr_count",
  "regr_intercept",
  "regr_r2",
  "regr_sxx",
  "regr_sxy",
  "regr_syy",
  "regr_slope",
  "safe_add",
  "safe_divide",
  "safe_multiply",
  "safe_subtract",
  "s_h_a2",
  "s_h_a2_digest",
  "sort_array",
  "split_part",
  "substring_index",
  "standard_hash",
  "str_position",
  "search",
  "search_ip",
  "str_to_date",
  "date_str_to_date",
  "date_to_date_str",
  "str_to_time",
  "str_to_unix",
  "str_to_map",
  "number_to_str",
  "from_base",
  "stuff",
  "time_to_str",
  "time_str_to_time",
  "ts_or_ds_add",
  "ts_or_ds_diff",
  "ts_or_ds_to_date",
  "ts_or_ds_to_time",
  "unhex",
  "uniform",
  "unix_to_str",
  "unix_to_time",
  "uuid",
  "timestamp_from_parts",
  "timestamp_tz_from_parts",
  "corr",
  "width_bucket",
  "covar_samp",
  "covar_pop",
  "week",
  "x_m_l_element",
  "x_m_l_get",
  "x_m_l_table",
  "x_m_l_key_value_option",
  "zipf",
  "merge",
  "when",
  "whens",
  "next_value_for",
  "return_stmt"
];
const expressionVariantNames = EXPRESSION_VARIANT_NAMES;
const expressionVariantNameSet = new Set(expressionVariantNames);
function getExprType(expr) {
  return Object.keys(expr)[0];
}
function getExprData(expr) {
  const key = Object.keys(expr)[0];
  return expr[key];
}
function isExpressionValue(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  return expressionVariantNameSet.has(keys[0]);
}
function makeExpr(type, data) {
  return { [type]: data };
}
function getInferredType(expr) {
  const data = getExprData(expr);
  if (data && typeof data === "object" && "inferred_type" in data) {
    const it = data.inferred_type;
    if (it != null) {
      return it;
    }
  }
  return void 0;
}
function isType(type) {
  return (expr) => type in expr;
}
const isSelect = isType("select");
const isInsert = isType("insert");
const isUpdate = isType("update");
const isDelete = isType("delete");
const isUnion = isType("union");
const isIntersect = isType("intersect");
const isExcept = isType("except");
const isSubquery = isType("subquery");
const isIdentifier = isType("identifier");
const isColumn = isType("column");
const isTable = isType("table");
const isStar = isType("star");
const isLiteral = isType("literal");
const isBoolean = isType("boolean");
const isNullLiteral = isType("null");
const isAnd = isType("and");
const isOr = isType("or");
const isNot = isType("not");
const isEq = isType("eq");
const isNeq = isType("neq");
const isLt = isType("lt");
const isLte = isType("lte");
const isGt = isType("gt");
const isGte = isType("gte");
const isLike = isType("like");
const isILike = isType("i_like");
const isAdd = isType("add");
const isSub = isType("sub");
const isMul = isType("mul");
const isDiv = isType("div");
const isMod = isType("mod");
const isConcat = isType("concat");
const isIn = isType("in");
const isBetween = isType("between");
const isIsNull = isType("is_null");
const isExists = isType("exists");
const isFunction = isType("function");
const isAggregateFunction = isType("aggregate_function");
const isWindowFunction = isType("window_function");
const isCount = isType("count");
const isSum = isType("sum");
const isAvg = isType("avg");
const isMin = isType("min");
const isMax = isType("max");
const isCoalesce = isType("coalesce");
const isNullIf = isType("null_if");
const isCast = isType("cast");
const isTryCast = isType("try_cast");
const isSafeCast = isType("safe_cast");
const isCase = isType("case");
const isFrom = isType("from");
const isJoin = isType("join");
const isWhere = isType("where");
const isGroupBy = isType("group_by");
const isHaving = isType("having");
const isOrderBy = isType("order_by");
const isLimit = isType("limit");
const isOffset = isType("offset");
const isWith = isType("with");
const isCte = isType("cte");
const isAlias = isType("alias");
const isParen = isType("paren");
const isOrdered = isType("ordered");
const isCreateTable = isType("create_table");
const isDropTable = isType("drop_table");
const isAlterTable = isType("alter_table");
const isCreateIndex = isType("create_index");
const isDropIndex = isType("drop_index");
const isCreateView = isType("create_view");
const isDropView = isType("drop_view");
function isQuery(expr) {
  const t = getExprType(expr);
  return t === "select" || t === "insert" || t === "update" || t === "delete";
}
function isSetOperation(expr) {
  const t = getExprType(expr);
  return t === "union" || t === "intersect" || t === "except";
}
function isComparison(expr) {
  const t = getExprType(expr);
  return t === "eq" || t === "neq" || t === "lt" || t === "lte" || t === "gt" || t === "gte" || t === "like" || t === "i_like";
}
function isArithmetic(expr) {
  const t = getExprType(expr);
  return t === "add" || t === "sub" || t === "mul" || t === "div" || t === "mod";
}
function isLogical(expr) {
  const t = getExprType(expr);
  return t === "and" || t === "or" || t === "not";
}
function isDDL(expr) {
  const t = getExprType(expr);
  return t === "create_table" || t === "drop_table" || t === "alter_table" || t === "create_index" || t === "drop_index" || t === "create_view" || t === "drop_view" || t === "create_schema" || t === "drop_schema" || t === "create_database" || t === "drop_database" || t === "create_function" || t === "drop_function" || t === "create_procedure" || t === "drop_procedure" || t === "create_sequence" || t === "drop_sequence" || t === "alter_sequence" || t === "create_trigger" || t === "drop_trigger" || t === "create_type" || t === "drop_type";
}
const removed = /* @__PURE__ */ Symbol("removed serialized AST value");
function processValue(value, location, options, removable) {
  if (value === null || value === void 0) return value;
  if (isExpressionValue(value)) {
    if (removable && options.removeArrayExpression?.(value, location) === true) {
      return removed;
    }
    return options.onExpression(value, location);
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isExpressionValue) && location.index === null && options.onExpressionArray) {
      options.onExpressionArray(value, location);
      return value;
    }
    let changed = options.cloneContainers;
    const processed = [];
    value.forEach((item, index2) => {
      const nextLocation = { ...location, index: index2 };
      const nextValue = processValue(item, nextLocation, options, true);
      if (nextValue === removed) {
        changed = true;
        return;
      }
      processed.push(nextValue);
      if (nextValue !== item) changed = true;
    });
    return changed ? processed : value;
  }
  if (typeof value === "object") {
    const object = value;
    const processed = {};
    let changed = options.cloneContainers;
    for (const [field, fieldValue] of Object.entries(object)) {
      const nextValue = processValue(fieldValue, location, options, false);
      if (nextValue === removed) {
        processed[field] = fieldValue;
      } else {
        processed[field] = nextValue;
        if (nextValue !== fieldValue) changed = true;
      }
    }
    return changed ? processed : value;
  }
  return value;
}
function collectExpressionChildren(parent) {
  const children = [];
  const innerData = getExprData(parent);
  if (!innerData || typeof innerData !== "object") return children;
  for (const [key, value] of Object.entries(innerData)) {
    processValue(
      value,
      { parent, key, index: null },
      {
        cloneContainers: false,
        onExpression: (node, location) => {
          children.push({ key: location.key, value: node });
          return node;
        },
        onExpressionArray: (nodes, location) => {
          children.push({ key: location.key, value: nodes });
        }
      },
      false
    );
  }
  return children;
}
function visitExpressionChildren(parent, visitor) {
  const innerData = getExprData(parent);
  if (!innerData || typeof innerData !== "object") return;
  for (const [key, value] of Object.entries(innerData)) {
    processValue(
      value,
      { parent, key, index: null },
      {
        cloneContainers: false,
        onExpression: (node, location) => {
          visitor(node, location);
          return node;
        }
      },
      false
    );
  }
}
function mapExpressionChildren(parent, transform2, removeArrayExpression) {
  const innerData = getExprData(parent);
  const processed = {};
  for (const [key, value] of Object.entries(innerData)) {
    const nextValue = processValue(
      value,
      { parent, key, index: null },
      {
        cloneContainers: true,
        onExpression: transform2,
        removeArrayExpression
      },
      false
    );
    processed[key] = nextValue === removed ? value : nextValue;
  }
  return processed;
}
function exprToJson$1(node) {
  return JSON.stringify(node);
}
function parseAstResult(json) {
  const result = JSON.parse(json);
  return result.success ? JSON.parse(result.ast) : null;
}
function isQueryWithOuterClauses(node) {
  return ["select", "union", "intersect", "except"].includes(getExprType(node));
}
function applyLimitExpr(node, limit) {
  const type = getExprType(node);
  if (!isQueryWithOuterClauses(node)) {
    return node;
  }
  const data = getExprData(node);
  if (type === "select") {
    return makeExpr("select", {
      ...data,
      limit: { this: limit, percent: false, comments: [] }
    });
  }
  return makeExpr(type, {
    ...data,
    limit
  });
}
function applyOffsetExpr(node, offset) {
  const type = getExprType(node);
  if (!isQueryWithOuterClauses(node)) {
    return node;
  }
  const data = getExprData(node);
  if (type === "select") {
    return makeExpr("select", {
      ...data,
      offset: { this: offset, rows: null }
    });
  }
  return makeExpr(type, {
    ...data,
    offset
  });
}
function applyOrderBy(node, orderBy) {
  const type = getExprType(node);
  if (!isQueryWithOuterClauses(node)) {
    return node;
  }
  const expressions = orderBy.map((expression) => {
    if (getExprType(expression) === "ordered") {
      return getExprData(expression);
    }
    return {
      this: expression,
      desc: false,
      nulls_first: null,
      explicit_asc: false,
      with_fill: null
    };
  });
  return makeExpr(type, {
    ...getExprData(node),
    order_by: {
      expressions,
      siblings: false,
      comments: []
    }
  });
}
function transformNode(node, config, parent, key, index2) {
  let currentNode = node;
  if (config.enter) {
    const result = config.enter(currentNode, parent, key, index2);
    if (result === null) {
      return currentNode;
    }
    if (result !== void 0) {
      currentNode = result;
    }
  }
  const nodeType = getExprType(currentNode);
  const typeCallback = config[nodeType];
  if (typeCallback) {
    const result = typeCallback(currentNode, parent, key, index2);
    if (result === null) {
      return currentNode;
    }
    if (result !== void 0) {
      currentNode = result;
    }
  }
  const currentType = getExprType(currentNode);
  const innerData = getExprData(currentNode);
  let newNode;
  if (innerData === null || innerData === void 0) {
    newNode = makeExpr(currentType, innerData);
  } else {
    const newInnerData = mapExpressionChildren(
      currentNode,
      (child, location) => transformNode(
        child,
        config,
        location.parent,
        location.key,
        location.index
      )
    );
    newNode = makeExpr(currentType, newInnerData);
  }
  if (config.leave) {
    const result = config.leave(newNode, parent, key, index2);
    if (result !== void 0 && result !== null) {
      return result;
    }
  }
  return newNode;
}
function transform(node, config) {
  return transformNode(node, config, null, null, null);
}
function replaceNodes(node, predicate, replacement) {
  return transform(node, {
    enter: (n, parent) => {
      if (predicate(n, parent)) {
        return typeof replacement === "function" ? replacement(n) : replacement;
      }
      return void 0;
    }
  });
}
function replaceByType(node, type, replacement) {
  return replaceNodes(
    node,
    (n) => getExprType(n) === type,
    typeof replacement === "function" ? (n) => replacement(n) : replacement
  );
}
function renameColumns(node, mapping) {
  const result = parseAstResult(
    ast_rename_columns$1(exprToJson$1(node), JSON.stringify(mapping))
  );
  return result ?? node;
}
function renameTables(node, mapping, options) {
  const result = parseAstResult(
    options ? ast_rename_tables_with_options$1(
      exprToJson$1(node),
      JSON.stringify(mapping),
      JSON.stringify(options)
    ) : ast_rename_tables$1(exprToJson$1(node), JSON.stringify(mapping))
  );
  return result ?? node;
}
function qualifyColumns(node, tableName) {
  const result = parseAstResult(
    ast_qualify_columns$1(exprToJson$1(node), tableName)
  );
  return result ?? node;
}
function qualifyTables(node, options = {}) {
  const result = parseAstResult(
    ast_qualify_tables$1(exprToJson$1(node), JSON.stringify(options))
  );
  return result ?? node;
}
function addWhere(node, condition2, operator = "and") {
  const result = parseAstResult(
    ast_add_where$1(exprToJson$1(node), exprToJson$1(condition2), operator === "or")
  );
  return result ?? node;
}
function removeWhere(node) {
  const result = parseAstResult(ast_remove_where$1(exprToJson$1(node)));
  return result ?? node;
}
function addSelectColumns(node, ...columns) {
  if (getExprType(node) !== "select") {
    return node;
  }
  const selectData = getExprData(node);
  return makeExpr("select", {
    ...selectData,
    expressions: [...selectData.expressions, ...columns]
  });
}
function removeSelectColumns(node, predicate) {
  if (getExprType(node) !== "select") {
    return node;
  }
  const selectData = getExprData(node);
  return makeExpr("select", {
    ...selectData,
    expressions: selectData.expressions.filter((col2) => !predicate(col2))
  });
}
function setLimit(node, limit) {
  if (typeof limit === "number") {
    const result = parseAstResult(ast_set_limit$1(exprToJson$1(node), limit));
    return result ?? node;
  }
  return applyLimitExpr(node, limit);
}
function setOffset(node, offset) {
  if (typeof offset === "number") {
    const result = parseAstResult(ast_set_offset$1(exprToJson$1(node), offset));
    return result ?? node;
  }
  return applyOffsetExpr(node, offset);
}
function setOrderBy(node, orderBy) {
  const orderByExpressions = Array.isArray(orderBy) ? orderBy : [orderBy];
  const result = parseAstResult(
    ast_set_order_by$1(exprToJson$1(node), JSON.stringify(orderByExpressions))
  );
  return result ?? applyOrderBy(node, orderByExpressions);
}
function removeLimitOffset(node) {
  if (getExprType(node) !== "select") {
    return node;
  }
  const selectData = getExprData(node);
  return makeExpr("select", {
    ...selectData,
    limit: null,
    offset: null
  });
}
function setDistinct(node, distinct = true) {
  const result = parseAstResult(ast_set_distinct$1(exprToJson$1(node), distinct));
  return result ?? node;
}
function clone(node) {
  return transform(node, {});
}
function remove(node, predicate) {
  const nodeType = getExprType(node);
  const innerData = getExprData(node);
  if (innerData === null || innerData === void 0) return node;
  const newInnerData = mapExpressionChildren(
    node,
    (child) => remove(child, predicate),
    (child, location) => predicate(child, location.parent)
  );
  return makeExpr(nodeType, newInnerData);
}
function exprToJson(node) {
  return JSON.stringify(node);
}
function getChildren(node) {
  return collectExpressionChildren(node);
}
function walk(node, visitor, parent = null, key = null, index2 = null) {
  if (visitor.enter) {
    visitor.enter(node, parent, key, index2);
  }
  const nodeType = getExprType(node);
  const typeCallback = visitor[nodeType];
  if (typeCallback) {
    typeCallback(node, parent, key, index2);
  }
  visitExpressionChildren(node, (child, location) => {
    walk(child, visitor, location.parent, location.key, location.index);
  });
  if (visitor.leave) {
    visitor.leave(node, parent, key, index2);
  }
}
function findAll(node, predicate) {
  const results = [];
  walk(node, {
    enter: (n, parent) => {
      if (predicate(n, parent)) {
        results.push(n);
      }
    }
  });
  return results;
}
function findByType(node, type) {
  return findAll(node, (n) => getExprType(n) === type);
}
function findFirst(node, predicate) {
  let result;
  let found = false;
  walk(node, {
    enter: (n, parent) => {
      if (!found && predicate(n, parent)) {
        result = n;
        found = true;
      }
    }
  });
  return result;
}
function some(node, predicate) {
  return findFirst(node, predicate) !== void 0;
}
function every(node, predicate) {
  let result = true;
  walk(node, {
    enter: (n, parent) => {
      if (!predicate(n, parent)) {
        result = false;
      }
    }
  });
  return result;
}
function countNodes(node, predicate) {
  return findAll(node, predicate).length;
}
function getColumns(node) {
  return findByType(node, "column");
}
function getTables(node) {
  const result = JSON.parse(ast_get_tables$1(exprToJson(node)));
  return result.success ? JSON.parse(result.ast) : [];
}
function getIdentifiers(node) {
  return findByType(node, "identifier");
}
function getFunctions(node) {
  const result = JSON.parse(ast_get_functions$1(exprToJson(node)));
  return result.success ? JSON.parse(result.ast) : [];
}
function getAggregateFunctions(node) {
  const result = JSON.parse(ast_get_aggregate_functions$1(exprToJson(node)));
  return result.success ? JSON.parse(result.ast) : [];
}
function getWindowFunctions(node) {
  const result = JSON.parse(ast_get_window_functions$1(exprToJson(node)));
  return result.success ? JSON.parse(result.ast) : [];
}
function getSubqueries(node) {
  const result = JSON.parse(ast_get_subqueries$1(exprToJson(node)));
  return result.success ? JSON.parse(result.ast) : [];
}
function getLiterals(node) {
  const result = JSON.parse(ast_get_literals$1(exprToJson(node)));
  return result.success ? JSON.parse(result.ast) : [];
}
function getColumnNames(node) {
  const result = JSON.parse(ast_get_column_names$1(exprToJson(node)));
  return result.success ? result.result : [];
}
function getTableNames(node) {
  const result = JSON.parse(ast_get_table_names$1(exprToJson(node)));
  return result.success ? result.result : [];
}
function hasAggregates(node) {
  return getAggregateFunctions(node).length > 0;
}
function hasWindowFunctions(node) {
  return getWindowFunctions(node).length > 0;
}
function hasSubqueries(node) {
  return getSubqueries(node).length > 0;
}
function getDepth(node) {
  let maxDepth = 0;
  let currentDepth = 0;
  walk(node, {
    enter: () => {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    },
    leave: () => {
      currentDepth--;
    }
  });
  return maxDepth;
}
function nodeCount(node) {
  const result = JSON.parse(ast_node_count$1(exprToJson(node)));
  return result.success ? result.result : 0;
}
function getParent(root, target) {
  let parentNode = null;
  walk(root, {
    enter: (node, parent) => {
      if (node === target) {
        parentNode = parent;
      }
    }
  });
  return parentNode;
}
function findAncestor(root, target, predicate) {
  const ancestors = [];
  let result = null;
  walk(root, {
    enter: (node) => {
      if (result !== null) return;
      if (node === target) {
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const parent = i > 0 ? ancestors[i - 1] : null;
          if (predicate(ancestors[i], parent)) {
            result = ancestors[i];
            break;
          }
        }
      }
      ancestors.push(node);
    },
    leave: () => {
      ancestors.pop();
    }
  });
  return result;
}
function getNodeDepth(root, target) {
  let depth = 0;
  let currentDepth = 0;
  walk(root, {
    enter: (node) => {
      currentDepth++;
      if (node === target) {
        depth = currentDepth;
      }
    },
    leave: () => {
      currentDepth--;
    }
  });
  return depth;
}
const index$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  addSelectColumns,
  addWhere,
  clone,
  countNodes,
  every,
  findAll,
  findAncestor,
  findByType,
  findFirst,
  getAggregateFunctions,
  getChildren,
  getColumnNames,
  getColumns,
  getDepth,
  getExprData,
  getExprType,
  getFunctions,
  getIdentifiers,
  getInferredType,
  getLiterals,
  getNodeDepth,
  getParent,
  getSubqueries,
  getTableNames,
  getTables,
  getWindowFunctions,
  hasAggregates,
  hasSubqueries,
  hasWindowFunctions,
  isAdd,
  isAggregateFunction,
  isAlias,
  isAlterTable,
  isAnd,
  isArithmetic,
  isAvg,
  isBetween,
  isBoolean,
  isCase,
  isCast,
  isCoalesce,
  isColumn,
  isComparison,
  isConcat,
  isCount,
  isCreateIndex,
  isCreateTable,
  isCreateView,
  isCte,
  isDDL,
  isDelete,
  isDiv,
  isDropIndex,
  isDropTable,
  isDropView,
  isEq,
  isExcept,
  isExists,
  isExpressionValue,
  isFrom,
  isFunction,
  isGroupBy,
  isGt,
  isGte,
  isHaving,
  isILike,
  isIdentifier,
  isIn,
  isInsert,
  isIntersect,
  isIsNull,
  isJoin,
  isLike,
  isLimit,
  isLiteral,
  isLogical,
  isLt,
  isLte,
  isMax,
  isMin,
  isMod,
  isMul,
  isNeq,
  isNot,
  isNullIf,
  isNullLiteral,
  isOffset,
  isOr,
  isOrderBy,
  isOrdered,
  isParen,
  isQuery,
  isSafeCast,
  isSelect,
  isSetOperation,
  isStar,
  isSub,
  isSubquery,
  isSum,
  isTable,
  isTryCast,
  isUnion,
  isUpdate,
  isWhere,
  isWindowFunction,
  isWith,
  makeExpr,
  nodeCount,
  qualifyColumns,
  qualifyTables,
  remove,
  removeLimitOffset,
  removeSelectColumns,
  removeWhere,
  renameColumns,
  renameTables,
  replaceByType,
  replaceNodes,
  setDistinct,
  setLimit,
  setOffset,
  setOrderBy,
  some,
  transform,
  walk
}, Symbol.toStringTag, { value: "Module" }));
class Expression {
  #plan;
  #readDialect;
  constructor(plan2, readDialect = "generic") {
    this.#plan = plan2;
    this.#readDialect = readDialect;
  }
  static fromNode(node, readDialect = "generic") {
    return new Expression({ base: node, operations: [] }, readDialect);
  }
  /** @internal */
  _planNode() {
    return this.#plan.operations.length === 0 ? this.#plan.base : { kind: "plan", plan: this.#plan };
  }
  /** Use this source dialect when parsing string fragments in the plan. */
  readDialect(dialect) {
    return new Expression(this.#plan, dialect || "generic");
  }
  build() {
    return wasm_compat_build$1(this.#request({ kind: "ast" }));
  }
  sql(dialect = "generic") {
    return wasm_compat_build$1(
      this.#request({ kind: "sql", dialect: dialect || "generic" })
    );
  }
  eq(other) {
    return this.#binary("eq", other);
  }
  neq(other) {
    return this.#binary("neq", other);
  }
  lt(other) {
    return this.#binary("lt", other);
  }
  lte(other) {
    return this.#binary("lte", other);
  }
  gt(other) {
    return this.#binary("gt", other);
  }
  gte(other) {
    return this.#binary("gte", other);
  }
  add(other) {
    return this.#binary("add", other);
  }
  sub(other) {
    return this.#binary("sub", other);
  }
  mul(other) {
    return this.#binary("mul", other);
  }
  div(other) {
    return this.#binary("div", other);
  }
  mod(other) {
    return this.#binary("mod", other);
  }
  is(other) {
    return this.#binary("is", other);
  }
  and_(other) {
    return this.#binary("and", other, true);
  }
  or_(other) {
    return this.#binary("or", other, true);
  }
  xor(other) {
    return this.#binary("xor", other, true);
  }
  like(other) {
    return this.#binary("like", other);
  }
  ilike(other) {
    return this.#binary("ilike", other);
  }
  rlike(other) {
    return this.#binary("rlike", other);
  }
  not_() {
    return this.#unary("not");
  }
  neg() {
    return this.#unary("neg");
  }
  isNull() {
    return this.#unary("is_null");
  }
  isNotNull() {
    return this.#unary("is_not_null");
  }
  as_(alias2) {
    return this.#derive({ kind: "alias", expression: this._planNode(), alias: alias2 });
  }
  cast(to) {
    return this.#derive({ kind: "cast", expression: this._planNode(), to });
  }
  asc() {
    return this.#derive({
      kind: "ordered",
      expression: this._planNode(),
      desc: false
    });
  }
  desc() {
    return this.#derive({
      kind: "ordered",
      expression: this._planNode(),
      desc: true
    });
  }
  between(low, high) {
    return this.#derive({
      kind: "between",
      expression: this._planNode(),
      low: nodeFor(low, false),
      high: nodeFor(high, false)
    });
  }
  isin(...values) {
    return this.#derive({
      kind: "in_list",
      expression: this._planNode(),
      values: values.map((value) => nodeFor(value, false)),
      negated: false
    });
  }
  notIn(...values) {
    return this.#derive({
      kind: "in_list",
      expression: this._planNode(),
      values: values.map((value) => nodeFor(value, false)),
      negated: true
    });
  }
  select(...values) {
    const [options, expressions] = listArguments(values);
    return this.#listOperation("select", expressions, options.append ?? true);
  }
  from_(source) {
    return this.#apply({ kind: "from", source: nodeFor(source, true) });
  }
  join(source, options = {}) {
    return this.#apply({
      kind: "join",
      source: nodeFor(source, true),
      on: options.on === void 0 ? null : nodeFor(options.on, true),
      join_type: options.joinType ?? "inner"
    });
  }
  where(...values) {
    const [options, expressions] = listArguments(values);
    return this.#listOperation("where", expressions, options.append ?? true);
  }
  groupBy(...values) {
    const [options, expressions] = listArguments(values);
    return this.#listOperation("group_by", expressions, options.append ?? true);
  }
  having(...values) {
    const [options, expressions] = listArguments(values);
    return this.#listOperation("having", expressions, options.append ?? true);
  }
  orderBy(...values) {
    const [options, expressions] = listArguments(values);
    return this.#listOperation("order_by", expressions, options.append ?? true);
  }
  sortBy(...values) {
    const [options, expressions] = listArguments(values);
    return this.#listOperation("sort_by", expressions, options.append ?? true);
  }
  qualify(...values) {
    const [options, expressions] = listArguments(values);
    return this.#listOperation("qualify", expressions, options.append ?? true);
  }
  lateralView(expression, options = {}) {
    return this.#apply({
      kind: "lateral_view",
      expression: nodeFor(expression, true),
      table_alias: options.tableAlias ?? null,
      column_aliases: options.columnAliases ?? [],
      outer: options.outer ?? false
    });
  }
  window(name, options = {}) {
    return this.#apply({
      kind: "window",
      name,
      partition_by: (options.partitionBy ?? []).map(
        (value) => nodeFor(value, true)
      ),
      order_by: (options.orderBy ?? []).map((value) => nodeFor(value, true))
    });
  }
  forUpdate() {
    return this.#apply({ kind: "lock", lock_type: "update" });
  }
  forShare() {
    return this.#apply({ kind: "lock", lock_type: "share" });
  }
  hint(text) {
    return this.#apply({ kind: "hint", text });
  }
  ctas(table2, options = {}) {
    return this.#apply({
      kind: "ctas",
      table: table2,
      replace: options.replace ?? false,
      temporary: options.temporary ?? false
    });
  }
  limit(expression) {
    return this.#apply({
      kind: "limit",
      expression: nodeFor(expression, false)
    });
  }
  offset(expression) {
    return this.#apply({
      kind: "offset",
      expression: nodeFor(expression, false)
    });
  }
  distinct(enabled = true) {
    return this.#apply({ kind: "distinct", enabled });
  }
  subquery(alias2) {
    return this.#apply({ kind: "subquery", alias: alias2 ?? null });
  }
  union(other, distinct = true) {
    return this.#apply({ kind: "union", other: other._planNode(), distinct });
  }
  intersect(other, distinct = true) {
    return this.#apply({
      kind: "intersect",
      other: other._planNode(),
      distinct
    });
  }
  except_(other, distinct = true) {
    return this.#apply({ kind: "except", other: other._planNode(), distinct });
  }
  when(condition2, result) {
    return this.#apply({
      kind: "when",
      condition: nodeFor(condition2, true),
      result: nodeFor(result, true)
    });
  }
  else_(result) {
    return this.#apply({ kind: "else", result: nodeFor(result, true) });
  }
  set_(assignments) {
    return this.#apply({
      kind: "set",
      assignments: assignmentNodes(assignments)
    });
  }
  insertColumns(columns) {
    return this.#apply({ kind: "insert_columns", columns });
  }
  values(...rows) {
    return this.#apply({
      kind: "values",
      rows: rows.map((row) => row.map((value) => nodeFor(value, false))),
      append: true
    });
  }
  query(query) {
    return this.#apply({ kind: "query", query: query._planNode() });
  }
  mergeUsing(source, on) {
    return this.#apply({
      kind: "merge_using",
      source: nodeFor(source, true),
      on: nodeFor(on, true)
    });
  }
  whenMatchedUpdate(assignments, condition2) {
    return this.#apply({
      kind: "when_matched_update",
      assignments: assignmentNodes(assignments),
      condition: condition2 === void 0 ? null : nodeFor(condition2, true)
    });
  }
  whenMatchedDelete(condition2) {
    return this.#apply({
      kind: "when_matched_delete",
      condition: condition2 === void 0 ? null : nodeFor(condition2, true)
    });
  }
  whenNotMatchedInsert(columns, values, condition2) {
    return this.#apply({
      kind: "when_not_matched_insert",
      columns,
      values: values.map((value) => nodeFor(value, false)),
      condition: condition2 === void 0 ? null : nodeFor(condition2, true)
    });
  }
  #binary(op, other, parseString = false) {
    return this.#derive({
      kind: "binary",
      op,
      left: this._planNode(),
      right: nodeFor(other, parseString)
    });
  }
  #unary(op) {
    return this.#derive({ kind: "unary", op, expression: this._planNode() });
  }
  #listOperation(kind, expressions, append = true) {
    return this.#apply({
      kind,
      expressions: expressions.map((value) => nodeFor(value, true)),
      append
    });
  }
  #apply(operation) {
    return new Expression(
      {
        base: this.#plan.base,
        operations: [...this.#plan.operations, operation]
      },
      this.#readDialect
    );
  }
  #derive(node) {
    return Expression.fromNode(node, this.#readDialect);
  }
  #request(output) {
    return {
      version: 1,
      read_dialect: this.#readDialect,
      plan: this.#plan,
      output
    };
  }
}
function sqlExpr$1(sql) {
  return Expression.fromNode({ kind: "sql", sql });
}
function column(name, table2) {
  return Expression.fromNode({
    kind: "column",
    name: table2 ? `${table2}.${name}` : name
  });
}
const col$1 = column;
function table_(name) {
  return Expression.fromNode({ kind: "table", name });
}
function convert(value) {
  return Expression.fromNode(nodeFor(value, false));
}
const lit$1 = convert;
function condition$1(value) {
  return Expression.fromNode(nodeFor(value, true));
}
function func$1(name, ...args) {
  return Expression.fromNode({
    kind: "function",
    name,
    args: args.map((value) => nodeFor(value, true))
  });
}
function builtin(functionName, ...args) {
  return Expression.fromNode({
    kind: "builtin",
    function: functionName,
    args: args.map((value) => nodeFor(value, true))
  });
}
const count$1 = (expression) => builtin("count", expression);
const countStar = () => builtin("count_star");
const countDistinct$1 = (expression) => builtin("count_distinct", expression);
const sum$1 = (expression) => builtin("sum", expression);
const avg$1 = (expression) => builtin("avg", expression);
const min$1 = (expression) => builtin("min", expression);
const max$1 = (expression) => builtin("max", expression);
const approxDistinct = (expression) => builtin("approx_distinct", expression);
const upper$1 = (expression) => builtin("upper", expression);
const lower$1 = (expression) => builtin("lower", expression);
const length$1 = (expression) => builtin("length", expression);
const trim$1 = (expression) => builtin("trim", expression);
const ltrim$1 = (expression) => builtin("ltrim", expression);
const rtrim$1 = (expression) => builtin("rtrim", expression);
const reverse$1 = (expression) => builtin("reverse", expression);
const initcap$1 = (expression) => builtin("initcap", expression);
const substring$1 = (expression, start, length2) => length2 === void 0 ? builtin("substring", expression, start) : builtin("substring", expression, start, length2);
const replace$1 = (expression, old, replacement) => builtin("replace", expression, old, replacement);
const concatWs$1 = (separator, ...expressions) => builtin("concat_ws", separator, ...expressions);
const coalesce$1 = (...expressions) => builtin("coalesce", ...expressions);
const nullIf$1 = (left, right) => builtin("null_if", left, right);
const ifNull$1 = (expression, fallback) => builtin("if_null", expression, fallback);
const abs$1 = (expression) => builtin("abs", expression);
const round$1 = (expression, decimals) => decimals === void 0 ? builtin("round", expression) : builtin("round", expression, decimals);
const floor$1 = (expression) => builtin("floor", expression);
const ceil$1 = (expression) => builtin("ceil", expression);
const power$1 = (base, exponent) => builtin("power", base, exponent);
const sqrt$1 = (expression) => builtin("sqrt", expression);
const ln$1 = (expression) => builtin("ln", expression);
const exp$1 = (expression) => builtin("exp", expression);
const sign$1 = (expression) => builtin("sign", expression);
const greatest$1 = (...expressions) => builtin("greatest", ...expressions);
const least$1 = (...expressions) => builtin("least", ...expressions);
const currentDate$1 = () => builtin("current_date");
const currentTime$1 = () => builtin("current_time");
const currentTimestamp$1 = () => builtin("current_timestamp");
const extract$1 = (field, expression) => Expression.fromNode({
  kind: "extract",
  field,
  expression: nodeFor(expression, true)
});
const rowNumber$1 = () => builtin("row_number");
const rank$1 = () => builtin("rank");
const denseRank$1 = () => builtin("dense_rank");
function select$1(...expressions) {
  return Expression.fromNode({
    kind: "select",
    expressions: expressions.map((value) => nodeFor(value, true))
  });
}
function from_(source) {
  return select$1().from_(source);
}
function caseBuilder(operand) {
  return Expression.fromNode({
    kind: "case",
    operand: operand === void 0 ? null : nodeFor(operand, true)
  });
}
function deleteBuilder(table2, where) {
  return Expression.fromNode({
    kind: "delete",
    table: table2,
    where_clause: where === void 0 ? null : nodeFor(where, true)
  });
}
function update$1(table2, assignments = {}) {
  return Expression.fromNode({
    kind: "update",
    table: table2,
    assignments: assignmentNodes(assignments),
    where_clause: null,
    from: null
  });
}
function insert$1(source, into, columns = []) {
  return Expression.fromNode({
    kind: "insert",
    into,
    expression: nodeFor(source, true),
    columns
  });
}
function insertInto$1(into) {
  return Expression.fromNode({
    kind: "insert",
    into,
    expression: null,
    columns: []
  });
}
function mergeInto$1(target) {
  return Expression.fromNode({ kind: "merge", target });
}
function and_(...expressions) {
  return combine("and", expressions);
}
function or_(...expressions) {
  return combine("or", expressions);
}
function not_(expression) {
  return condition$1(expression).not_();
}
function alias_(expression, alias2) {
  return condition$1(expression).as_(alias2);
}
function union$1(left, right, distinct = true) {
  return left.union(right, distinct);
}
function intersect$1(left, right, distinct = true) {
  return left.intersect(right, distinct);
}
function except_(left, right, distinct = true) {
  return left.except_(right, distinct);
}
function nodeFor(value, parseString) {
  if (value instanceof Expression) {
    return expressionNode(value);
  }
  if (typeof value === "string") {
    return parseString ? { kind: "sql", sql: value } : { kind: "literal", value: { kind: "string", value } };
  }
  if (value === null) return { kind: "literal", value: { kind: "null" } };
  if (typeof value === "boolean")
    return { kind: "literal", value: { kind: "bool", value } };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { kind: "literal", value: { kind: "integer", value } } : { kind: "literal", value: { kind: "float", value } };
  }
  throw new TypeError(`Unsupported builder input: ${String(value)}`);
}
function listArguments(values) {
  const first = values[0];
  if (typeof first === "object" && first !== null && !(first instanceof Expression)) {
    return [first, values.slice(1)];
  }
  return [{}, values];
}
function expressionNode(expression) {
  return expression._planNode();
}
function assignmentNodes(values) {
  return Object.entries(values).map(([column2, value]) => ({
    column: column2,
    value: nodeFor(value, false)
  }));
}
function combine(op, values) {
  if (values.length === 0)
    throw new TypeError(`${op.toUpperCase()} requires at least one expression`);
  return values.slice(1).reduce(
    (left, right) => Expression.fromNode({
      kind: "binary",
      op,
      left: expressionNode(left),
      right: nodeFor(right, true)
    }),
    condition$1(values[0])
  );
}
const compat2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  Expression,
  abs: abs$1,
  alias_,
  and_,
  approxDistinct,
  avg: avg$1,
  case: caseBuilder,
  ceil: ceil$1,
  coalesce: coalesce$1,
  col: col$1,
  column,
  concatWs: concatWs$1,
  condition: condition$1,
  convert,
  count: count$1,
  countDistinct: countDistinct$1,
  countStar,
  currentDate: currentDate$1,
  currentTime: currentTime$1,
  currentTimestamp: currentTimestamp$1,
  delete: deleteBuilder,
  denseRank: denseRank$1,
  except_,
  exp: exp$1,
  extract: extract$1,
  floor: floor$1,
  from_,
  func: func$1,
  greatest: greatest$1,
  ifNull: ifNull$1,
  initcap: initcap$1,
  insert: insert$1,
  insertInto: insertInto$1,
  intersect: intersect$1,
  least: least$1,
  length: length$1,
  lit: lit$1,
  ln: ln$1,
  lower: lower$1,
  ltrim: ltrim$1,
  max: max$1,
  mergeInto: mergeInto$1,
  min: min$1,
  not_,
  nullIf: nullIf$1,
  or_,
  power: power$1,
  rank: rank$1,
  replace: replace$1,
  reverse: reverse$1,
  round: round$1,
  rowNumber: rowNumber$1,
  rtrim: rtrim$1,
  select: select$1,
  sign: sign$1,
  sqlExpr: sqlExpr$1,
  sqrt: sqrt$1,
  substring: substring$1,
  sum: sum$1,
  table_,
  trim: trim$1,
  union: union$1,
  update: update$1,
  upper: upper$1
}, Symbol.toStringTag, { value: "Module" }));
function input(value) {
  if (value instanceof Expr) return value._expression;
  if (typeof value === "string") return col$1(value);
  return lit$1(value);
}
function inputs(values) {
  return values.map(input);
}
class Expr {
  /** @internal */
  _expression;
  /** @internal */
  constructor(expression) {
    this._expression = expression;
  }
  eq(other) {
    return new Expr(this._expression.eq(input(other)));
  }
  neq(other) {
    return new Expr(this._expression.neq(input(other)));
  }
  lt(other) {
    return new Expr(this._expression.lt(input(other)));
  }
  lte(other) {
    return new Expr(this._expression.lte(input(other)));
  }
  gt(other) {
    return new Expr(this._expression.gt(input(other)));
  }
  gte(other) {
    return new Expr(this._expression.gte(input(other)));
  }
  and(other) {
    return new Expr(this._expression.and_(input(other)));
  }
  or(other) {
    return new Expr(this._expression.or_(input(other)));
  }
  xor(other) {
    return new Expr(this._expression.xor(input(other)));
  }
  not() {
    return new Expr(this._expression.not_());
  }
  add(other) {
    return new Expr(this._expression.add(input(other)));
  }
  sub(other) {
    return new Expr(this._expression.sub(input(other)));
  }
  mul(other) {
    return new Expr(this._expression.mul(input(other)));
  }
  div(other) {
    return new Expr(this._expression.div(input(other)));
  }
  mod(other) {
    return new Expr(this._expression.mod(input(other)));
  }
  neg() {
    return new Expr(this._expression.neg());
  }
  is(other) {
    return new Expr(this._expression.is(input(other)));
  }
  like(pattern) {
    return new Expr(this._expression.like(input(pattern)));
  }
  ilike(pattern) {
    return new Expr(this._expression.ilike(input(pattern)));
  }
  rlike(pattern) {
    return new Expr(this._expression.rlike(input(pattern)));
  }
  isNull() {
    return new Expr(this._expression.isNull());
  }
  isNotNull() {
    return new Expr(this._expression.isNotNull());
  }
  between(low, high) {
    return new Expr(this._expression.between(input(low), input(high)));
  }
  inList(...values) {
    return new Expr(this._expression.isin(...inputs(values)));
  }
  notIn(...values) {
    return new Expr(this._expression.notIn(...inputs(values)));
  }
  alias(name) {
    return new Expr(this._expression.as_(name));
  }
  as(name) {
    return this.alias(name);
  }
  cast(to) {
    return new Expr(this._expression.cast(to));
  }
  asc() {
    return new Expr(this._expression.asc());
  }
  desc() {
    return new Expr(this._expression.desc());
  }
  toSql(dialect = "generic") {
    return this._expression.sql(dialect);
  }
  toJSON() {
    return this._expression.build();
  }
  free() {
  }
}
class WindowDefBuilder {
  /** @internal */
  _partitionBy = [];
  /** @internal */
  _orderBy = [];
  partitionBy(...expressions) {
    this._partitionBy = inputs(expressions);
    return this;
  }
  orderBy(...expressions) {
    this._orderBy = inputs(expressions);
    return this;
  }
  free() {
  }
}
function col(name) {
  return new Expr(col$1(name));
}
function lit(value) {
  return new Expr(lit$1(value));
}
function star() {
  return new Expr(condition$1("*"));
}
function sqlNull() {
  return new Expr(lit$1(null));
}
function boolean(value) {
  return new Expr(lit$1(value));
}
function table(name) {
  return new Expr(table_(name));
}
function sqlExpr(sql) {
  return new Expr(sqlExpr$1(sql));
}
function condition(sql) {
  return sqlExpr(sql);
}
function func(name, ...args) {
  return new Expr(func$1(name, ...inputs(args)));
}
function not(expression) {
  return new Expr(not_(input(expression)));
}
function cast(expression, to) {
  return new Expr(input(expression).cast(to));
}
function alias(expression, name) {
  return new Expr(input(expression).as_(name));
}
function subquery(query, name) {
  return new Expr(query._current().subquery(name));
}
function and(...conditions) {
  if (conditions.length === 0) return boolean(true);
  if (conditions.length === 1 && conditions[0] instanceof Expr)
    return conditions[0];
  return new Expr(and_(...inputs(conditions)));
}
function or(...conditions) {
  if (conditions.length === 0) return boolean(false);
  if (conditions.length === 1 && conditions[0] instanceof Expr)
    return conditions[0];
  return new Expr(or_(...inputs(conditions)));
}
const count = (expression) => new Expr(
  expression === void 0 ? countStar() : count$1(input(expression))
);
const countDistinct = (expression) => new Expr(countDistinct$1(input(expression)));
const sum = (expression) => new Expr(sum$1(input(expression)));
const avg = (expression) => new Expr(avg$1(input(expression)));
const min = (expression) => new Expr(min$1(input(expression)));
const max = (expression) => new Expr(max$1(input(expression)));
const upper = (expression) => new Expr(upper$1(input(expression)));
const lower = (expression) => new Expr(lower$1(input(expression)));
const length = (expression) => new Expr(length$1(input(expression)));
const trim = (expression) => new Expr(trim$1(input(expression)));
const ltrim = (expression) => new Expr(ltrim$1(input(expression)));
const rtrim = (expression) => new Expr(rtrim$1(input(expression)));
const reverse = (expression) => new Expr(reverse$1(input(expression)));
const initcap = (expression) => new Expr(initcap$1(input(expression)));
function substring(expression, start, length2) {
  return new Expr(
    length2 === void 0 ? substring$1(input(expression), input(start)) : substring$1(input(expression), input(start), input(length2))
  );
}
const replace = (expression, from, to) => new Expr(replace$1(input(expression), input(from), input(to)));
const concatWs = (separator, ...expressions) => new Expr(concatWs$1(input(separator), ...inputs(expressions)));
const coalesce = (...expressions) => new Expr(coalesce$1(...inputs(expressions)));
const nullIf = (left, right) => new Expr(nullIf$1(input(left), input(right)));
const ifNull = (expression, fallback) => new Expr(ifNull$1(input(expression), input(fallback)));
const abs = (expression) => new Expr(abs$1(input(expression)));
function round(expression, decimals) {
  return new Expr(
    decimals === void 0 ? round$1(input(expression)) : round$1(input(expression), input(decimals))
  );
}
const floor = (expression) => new Expr(floor$1(input(expression)));
const ceil = (expression) => new Expr(ceil$1(input(expression)));
const power = (base, exponent) => new Expr(power$1(input(base), input(exponent)));
const sqrt = (expression) => new Expr(sqrt$1(input(expression)));
const ln = (expression) => new Expr(ln$1(input(expression)));
const exp = (expression) => new Expr(exp$1(input(expression)));
const sign = (expression) => new Expr(sign$1(input(expression)));
const greatest = (...expressions) => new Expr(greatest$1(...inputs(expressions)));
const least = (...expressions) => new Expr(least$1(...inputs(expressions)));
const currentDate = () => func("CURRENT_DATE");
const currentTime = () => func("CURRENT_TIME");
const currentTimestamp = () => func("CURRENT_TIMESTAMP");
const extract = (unit, from) => new Expr(extract$1(unit, input(from)));
const rowNumber = () => new Expr(rowNumber$1());
const rank = () => new Expr(rank$1());
const denseRank = () => new Expr(denseRank$1());
class StatefulBuilder {
  #consumed = false;
  ensureActive() {
    if (this.#consumed) throw new Error("Builder already consumed");
  }
  consume() {
    this.ensureActive();
    this.#consumed = true;
  }
  free() {
    this.#consumed = true;
  }
}
class SelectBuilder extends StatefulBuilder {
  #expression;
  constructor() {
    super();
    this.#expression = select$1();
  }
  /** @internal */
  _current() {
    this.ensureActive();
    return this.#expression;
  }
  select(...columns) {
    this.ensureActive();
    const values = columns.map(
      (column2) => column2 === "*" ? condition$1("*") : input(column2)
    );
    this.#expression = this.#expression.select(...values);
    return this;
  }
  from(tableOrExpression) {
    this.ensureActive();
    this.#expression = this.#expression.from_(
      typeof tableOrExpression === "string" ? table_(tableOrExpression) : tableOrExpression._expression
    );
    return this;
  }
  join(tableName, on) {
    this.#expression = this._current().join(tableName, {
      on: input(on),
      joinType: "inner"
    });
    return this;
  }
  leftJoin(tableName, on) {
    this.#expression = this._current().join(tableName, {
      on: input(on),
      joinType: "left"
    });
    return this;
  }
  rightJoin(tableName, on) {
    this.#expression = this._current().join(tableName, {
      on: input(on),
      joinType: "right"
    });
    return this;
  }
  fullJoin(tableName, on) {
    this.#expression = this._current().join(tableName, {
      on: input(on),
      joinType: "full"
    });
    return this;
  }
  crossJoin(tableName) {
    this.#expression = this._current().join(tableName, { joinType: "cross" });
    return this;
  }
  where(condition2) {
    this.#expression = this._current().where(
      typeof condition2 === "string" ? condition2 : input(condition2)
    );
    return this;
  }
  groupBy(...expressions) {
    this.#expression = this._current().groupBy(...inputs(expressions));
    return this;
  }
  having(condition2) {
    this.#expression = this._current().having(input(condition2));
    return this;
  }
  orderBy(...expressions) {
    this.#expression = this._current().orderBy(...inputs(expressions));
    return this;
  }
  sortBy(...expressions) {
    this.#expression = this._current().sortBy(...inputs(expressions));
    return this;
  }
  limit(value) {
    this.#expression = this._current().limit(value);
    return this;
  }
  offset(value) {
    this.#expression = this._current().offset(value);
    return this;
  }
  distinct() {
    this.#expression = this._current().distinct();
    return this;
  }
  qualify(condition2) {
    this.#expression = this._current().qualify(input(condition2));
    return this;
  }
  window(name, definition) {
    this.#expression = this._current().window(name, {
      partitionBy: definition._partitionBy,
      orderBy: definition._orderBy
    });
    return this;
  }
  lateral(functionExpression, tableAlias, columnAliases, options = {}) {
    this.#expression = this._current().lateralView(
      functionExpression._expression,
      { tableAlias, columnAliases, outer: options.outer }
    );
    return this;
  }
  hint(text) {
    this.#expression = this._current().hint(text);
    return this;
  }
  forUpdate() {
    this.#expression = this._current().forUpdate();
    return this;
  }
  forShare() {
    this.#expression = this._current().forShare();
    return this;
  }
  ctas(tableName, options = {}) {
    const result = this._current().ctas(tableName, options).build();
    this.consume();
    return result;
  }
  ctasSql(tableName, dialect = "generic", options = {}) {
    const result = this._current().ctas(tableName, options).sql(dialect);
    this.consume();
    return result;
  }
  union(other) {
    return new SetOpBuilder(this._current().union(other._current()));
  }
  unionAll(other) {
    return new SetOpBuilder(this._current().union(other._current(), false));
  }
  intersect(other) {
    return new SetOpBuilder(this._current().intersect(other._current()));
  }
  intersectAll(other) {
    return new SetOpBuilder(this._current().intersect(other._current(), false));
  }
  except(other) {
    return new SetOpBuilder(this._current().except_(other._current()));
  }
  exceptAll(other) {
    return new SetOpBuilder(this._current().except_(other._current(), false));
  }
  toSql(dialect = "generic") {
    const result = this._current().sql(dialect);
    this.consume();
    return result;
  }
  build() {
    const result = this._current().build();
    this.consume();
    return result;
  }
}
function select(...columns) {
  return new SelectBuilder().select(...columns);
}
class InsertBuilder extends StatefulBuilder {
  #expression;
  constructor(tableName) {
    super();
    this.#expression = insertInto$1(tableName);
  }
  columns(...columns) {
    this.ensureActive();
    this.#expression = this.#expression.insertColumns(columns);
    return this;
  }
  values(...values) {
    this.ensureActive();
    this.#expression = this.#expression.values(inputs(values));
    return this;
  }
  query(query) {
    this.ensureActive();
    this.#expression = this.#expression.query(query._current());
    return this;
  }
  toSql(dialect = "generic") {
    this.consume();
    return this.#expression.sql(dialect);
  }
  build() {
    this.consume();
    return this.#expression.build();
  }
}
const insertInto = (tableName) => new InsertBuilder(tableName);
const insert = insertInto;
class UpdateBuilder extends StatefulBuilder {
  #expression;
  constructor(tableName) {
    super();
    this.#expression = update$1(tableName);
  }
  set(column2, value) {
    this.ensureActive();
    this.#expression = this.#expression.set_({ [column2]: input(value) });
    return this;
  }
  where(condition2) {
    this.ensureActive();
    this.#expression = this.#expression.where(input(condition2));
    return this;
  }
  from(tableName) {
    this.ensureActive();
    this.#expression = this.#expression.from_(tableName);
    return this;
  }
  toSql(dialect = "generic") {
    this.consume();
    return this.#expression.sql(dialect);
  }
  build() {
    this.consume();
    return this.#expression.build();
  }
}
const update = (tableName) => new UpdateBuilder(tableName);
class DeleteBuilder extends StatefulBuilder {
  #expression;
  constructor(tableName) {
    super();
    this.#expression = deleteBuilder(tableName);
  }
  where(condition2) {
    this.ensureActive();
    this.#expression = this.#expression.where(input(condition2));
    return this;
  }
  toSql(dialect = "generic") {
    this.consume();
    return this.#expression.sql(dialect);
  }
  build() {
    this.consume();
    return this.#expression.build();
  }
}
const deleteFrom = (tableName) => new DeleteBuilder(tableName);
const del = deleteFrom;
class MergeBuilder extends StatefulBuilder {
  #expression;
  constructor(target) {
    super();
    this.#expression = mergeInto$1(target);
  }
  using(source, on) {
    this.ensureActive();
    this.#expression = this.#expression.mergeUsing(source, input(on));
    return this;
  }
  whenMatchedUpdate(assignments, condition2) {
    this.ensureActive();
    this.#expression = this.#expression.whenMatchedUpdate(
      Object.fromEntries(
        Object.entries(assignments).map(([column2, value]) => [
          column2,
          input(value)
        ])
      ),
      condition2 === void 0 ? void 0 : input(condition2)
    );
    return this;
  }
  whenMatchedDelete(condition2) {
    this.ensureActive();
    this.#expression = this.#expression.whenMatchedDelete(
      condition2 === void 0 ? void 0 : input(condition2)
    );
    return this;
  }
  whenNotMatchedInsert(columns, values, condition2) {
    this.ensureActive();
    this.#expression = this.#expression.whenNotMatchedInsert(
      columns,
      inputs(values),
      condition2 === void 0 ? void 0 : input(condition2)
    );
    return this;
  }
  toSql(dialect = "generic") {
    this.consume();
    return this.#expression.sql(dialect);
  }
  build() {
    this.consume();
    return this.#expression.build();
  }
}
const mergeInto = (target) => new MergeBuilder(target);
class CaseBuilder {
  #expression;
  constructor(expression = caseBuilder()) {
    this.#expression = expression;
  }
  when(condition2, result) {
    this.#expression = this.#expression.when(input(condition2), input(result));
    return this;
  }
  else_(result) {
    this.#expression = this.#expression.else_(input(result));
    return this;
  }
  build() {
    return new Expr(this.#expression);
  }
  toSql(dialect = "generic") {
    return this.#expression.sql(dialect);
  }
}
const caseWhen = () => new CaseBuilder();
const caseOf = (operand) => new CaseBuilder(caseBuilder(input(operand)));
class SetOpBuilder extends StatefulBuilder {
  #expression;
  constructor(expression) {
    super();
    this.#expression = expression;
  }
  orderBy(...expressions) {
    this.ensureActive();
    this.#expression = this.#expression.orderBy(...inputs(expressions));
    return this;
  }
  limit(value) {
    this.ensureActive();
    this.#expression = this.#expression.limit(value);
    return this;
  }
  offset(value) {
    this.ensureActive();
    this.#expression = this.#expression.offset(value);
    return this;
  }
  toSql(dialect = "generic") {
    this.consume();
    return this.#expression.sql(dialect);
  }
  build() {
    this.consume();
    return this.#expression.build();
  }
}
const union = (left, right) => new SetOpBuilder(left._current().union(right._current()));
const unionAll = (left, right) => new SetOpBuilder(left._current().union(right._current(), false));
const intersect = (left, right) => new SetOpBuilder(left._current().intersect(right._current()));
const except = (left, right) => new SetOpBuilder(left._current().except_(right._current()));
function diff(source, target, dialect = "generic", options = {}) {
  const { deltaOnly = false, f = 0.6, t = 0.6 } = options;
  const resultJson = diff_sql$1(source, target, dialect, deltaOnly, f, t);
  return JSON.parse(resultJson);
}
function hasChanges(edits) {
  return edits.some((e) => e.type !== "keep");
}
function changesOnly(edits) {
  return edits.filter((e) => e.type !== "keep");
}
function lineage(column2, sql, dialect = "generic", trimSelects = false) {
  const resultJson = lineage_sql$1(sql, column2, dialect, trimSelects);
  return JSON.parse(resultJson);
}
function lineageWithSchema(column2, sql, schema, dialect = "generic", trimSelects = false) {
  const resultJson = lineage_sql_with_schema$1(
    sql,
    column2,
    JSON.stringify(schema),
    dialect,
    trimSelects
  );
  return JSON.parse(resultJson);
}
function lineageAt(ordinal, sql, dialect = "generic", trimSelects = false) {
  const resultJson = lineage_sql_at$1(sql, ordinal, dialect, trimSelects);
  return JSON.parse(resultJson);
}
function lineageAtWithSchema(ordinal, sql, schema, dialect = "generic", trimSelects = false) {
  const resultJson = lineage_sql_at_with_schema$1(
    sql,
    ordinal,
    JSON.stringify(schema),
    dialect,
    trimSelects
  );
  return JSON.parse(resultJson);
}
function outputColumns(sql, dialect = "generic") {
  return JSON.parse(output_columns_sql$1(sql, dialect));
}
function outputColumnsWithSchema(sql, schema, dialect = "generic") {
  return JSON.parse(
    output_columns_sql_with_schema$1(sql, JSON.stringify(schema), dialect)
  );
}
function getSourceTables(column2, sql, dialect = "generic") {
  const resultJson = source_tables$1(sql, column2, dialect);
  return JSON.parse(resultJson);
}
function normalizeOptions(options) {
  return {
    dialect: "generic",
    datasetMappings: {},
    ...options
  };
}
function openLineageColumnLineage(sql, options) {
  const resultJson = openlineage_column_lineage$1(
    sql,
    JSON.stringify(normalizeOptions(options))
  );
  return JSON.parse(resultJson);
}
function openLineageJobEvent(sql, options) {
  const resultJson = openlineage_job_event$1(
    sql,
    JSON.stringify(normalizeOptions(options))
  );
  return JSON.parse(resultJson);
}
function openLineageRunEvent(sql, options) {
  const resultJson = openlineage_run_event$1(
    sql,
    JSON.stringify(normalizeOptions(options))
  );
  return JSON.parse(resultJson);
}
function plan(sql, dialect = "generic") {
  const resultJson = plan$2(sql, dialect);
  return JSON.parse(resultJson);
}
function parseValidationResult(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {
      valid: false,
      errors: [
        {
          message: "Failed to parse validation response",
          severity: "error",
          code: "E000"
        }
      ]
    };
  }
}
function validateWithSchema(sql, schema, dialect = "generic", options = {}) {
  const strict = options.strict ?? schema.strict ?? true;
  const wasmOptions = {
    check_types: options.checkTypes ?? false,
    check_references: options.checkReferences ?? false,
    strict,
    semantic: options.semantic ?? false,
    strict_syntax: options.strictSyntax ?? false
  };
  const resultJson = validate_with_schema$1(
    sql,
    JSON.stringify(schema),
    dialect,
    JSON.stringify(wasmOptions)
  );
  return parseValidationResult(resultJson);
}
const ValidationSeverity = {
  Error: "error",
  Warning: "warning"
};
const wasm$1 = wasmModule;
function validate(sql, dialect = "generic", options = {}) {
  const resultJson = options.strictSyntax || options.semantic ? wasm$1.validate_with_options(
    sql,
    dialect,
    JSON.stringify({
      strictSyntax: options.strictSyntax ?? false,
      semantic: options.semantic ?? false
    })
  ) : wasm$1.validate(sql, dialect);
  return JSON.parse(resultJson);
}
var Dialect = /* @__PURE__ */ ((Dialect2) => {
  Dialect2["Generic"] = "generic";
  Dialect2["PostgreSQL"] = "postgresql";
  Dialect2["MySQL"] = "mysql";
  Dialect2["BigQuery"] = "bigquery";
  Dialect2["Snowflake"] = "snowflake";
  Dialect2["DuckDB"] = "duckdb";
  Dialect2["SQLite"] = "sqlite";
  Dialect2["Hive"] = "hive";
  Dialect2["Spark"] = "spark";
  Dialect2["Trino"] = "trino";
  Dialect2["Presto"] = "presto";
  Dialect2["Redshift"] = "redshift";
  Dialect2["TSQL"] = "tsql";
  Dialect2["Oracle"] = "oracle";
  Dialect2["ClickHouse"] = "clickhouse";
  Dialect2["Databricks"] = "databricks";
  Dialect2["Athena"] = "athena";
  Dialect2["Teradata"] = "teradata";
  Dialect2["Doris"] = "doris";
  Dialect2["StarRocks"] = "starrocks";
  Dialect2["Materialize"] = "materialize";
  Dialect2["RisingWave"] = "risingwave";
  Dialect2["SingleStore"] = "singlestore";
  Dialect2["CockroachDB"] = "cockroachdb";
  Dialect2["TiDB"] = "tidb";
  Dialect2["Druid"] = "druid";
  Dialect2["Solr"] = "solr";
  Dialect2["Tableau"] = "tableau";
  Dialect2["Dune"] = "dune";
  Dialect2["Fabric"] = "fabric";
  Dialect2["Drill"] = "drill";
  Dialect2["Dremio"] = "dremio";
  Dialect2["Exasol"] = "exasol";
  Dialect2["DataFusion"] = "datafusion";
  return Dialect2;
})(Dialect || {});
const wasm = wasmModule;
function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}
function transpileFailure(context, error) {
  return {
    success: false,
    sql: void 0,
    error: `WASM ${context} failed: ${errorMessage(error)}`,
    errorLine: void 0,
    errorColumn: void 0
  };
}
function parseFailure(context, error) {
  return {
    success: false,
    ast: void 0,
    error: `WASM ${context} failed: ${errorMessage(error)}`,
    errorLine: void 0,
    errorColumn: void 0
  };
}
function dataTypeFailure(context, error) {
  return {
    success: false,
    dataType: void 0,
    error: `WASM ${context} failed: ${errorMessage(error)}`,
    errorLine: void 0,
    errorColumn: void 0
  };
}
function generateDataTypeFailure(context, error) {
  return {
    success: false,
    sql: void 0,
    error: `WASM ${context} failed: ${errorMessage(error)}`,
    errorLine: void 0,
    errorColumn: void 0
  };
}
function decodeWasmPayload(payload) {
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  return payload;
}
function queryAnalysisFailure(context, error) {
  return {
    success: false,
    analysis: void 0,
    error: `WASM ${context} failed: ${errorMessage(error)}`
  };
}
function normalizeAnalyzeQueryOptions(optionsOrDialect = {}) {
  if (typeof optionsOrDialect === "string") {
    return { dialect: optionsOrDialect };
  }
  return {
    dialect: "generic",
    ...optionsOrDialect
  };
}
async function init() {
  await __polyglot_init_wasm();
}
function isInitialized() {
  return !!__vite__wasmModule;
}
function transpile(sql, read, write, options) {
  try {
    if (options && Object.keys(options).length > 0) {
      if (typeof wasm.transpile_with_options_value === "function") {
        return decodeWasmPayload(
          wasm.transpile_with_options_value(sql, read, write, options)
        );
      }
      if (typeof wasm.transpile_with_options === "function") {
        return JSON.parse(
          wasm.transpile_with_options(
            sql,
            read,
            write,
            JSON.stringify(options)
          )
        );
      }
      return {
        success: false,
        sql: void 0,
        error: "WASM transpile options are not available in this build"
      };
    }
    if (typeof wasm.transpile_value === "function") {
      return decodeWasmPayload(
        wasm.transpile_value(sql, read, write)
      );
    }
    return JSON.parse(wasm.transpile(sql, read, write));
  } catch (error) {
    return transpileFailure("transpile", error);
  }
}
function parse(sql, dialect = "generic") {
  try {
    if (typeof wasm.parse_value === "function") {
      return decodeWasmPayload(wasm.parse_value(sql, dialect));
    }
    const result = JSON.parse(wasm.parse(sql, dialect));
    if (result.success && typeof result.ast === "string") {
      result.ast = JSON.parse(result.ast);
    }
    return result;
  } catch (error) {
    return parseFailure("parse", error);
  }
}
function parseDataType(sql, dialect = "generic") {
  try {
    if (typeof wasm.parse_data_type_value === "function") {
      return decodeWasmPayload(
        wasm.parse_data_type_value(sql, dialect)
      );
    }
    const result = JSON.parse(
      wasm.parse_data_type(sql, dialect)
    );
    if (result.success && typeof result.dataType === "string") {
      result.dataType = JSON.parse(result.dataType);
    }
    return result;
  } catch (error) {
    return dataTypeFailure("parseDataType", error);
  }
}
function tokenize(sql, dialect = "generic") {
  try {
    if (typeof wasm.tokenize_value === "function") {
      return decodeWasmPayload(
        wasm.tokenize_value(sql, dialect)
      );
    }
    return JSON.parse(wasm.tokenize(sql, dialect));
  } catch (error) {
    return {
      success: false,
      tokens: void 0,
      error: `WASM tokenize failed: ${errorMessage(error)}`
    };
  }
}
function generate(ast2, dialect = "generic") {
  try {
    if (typeof wasm.generate_value === "function" && Array.isArray(ast2)) {
      return decodeWasmPayload(
        wasm.generate_value(ast2, dialect)
      );
    }
    const astJson = JSON.stringify(ast2);
    return JSON.parse(wasm.generate(astJson, dialect));
  } catch (error) {
    return transpileFailure("generate", error);
  }
}
function generateDataType(dataType, dialect = "generic") {
  try {
    if (typeof wasm.generate_data_type_value === "function") {
      return decodeWasmPayload(
        wasm.generate_data_type_value(dataType, dialect)
      );
    }
    const dataTypeJson = JSON.stringify(dataType);
    return JSON.parse(
      wasm.generate_data_type(dataTypeJson, dialect)
    );
  } catch (error) {
    return generateDataTypeFailure("generateDataType", error);
  }
}
function format(sql, dialect = "generic") {
  return formatWithOptions(sql, dialect, {});
}
function formatWithOptions(sql, dialect = "generic", options = {}) {
  try {
    if (typeof wasm.format_sql_with_options_value === "function") {
      return decodeWasmPayload(
        wasm.format_sql_with_options_value(sql, dialect, options)
      );
    }
    if (typeof wasm.format_sql_with_options === "function") {
      return JSON.parse(
        wasm.format_sql_with_options(sql, dialect, JSON.stringify(options))
      );
    }
    if (typeof wasm.format_sql_value === "function") {
      return decodeWasmPayload(
        wasm.format_sql_value(sql, dialect)
      );
    }
    return JSON.parse(wasm.format_sql(sql, dialect));
  } catch (error) {
    return transpileFailure("format", error);
  }
}
function getDialects() {
  if (typeof wasm.get_dialects_value === "function") {
    return decodeWasmPayload(wasm.get_dialects_value());
  }
  return JSON.parse(wasm.get_dialects());
}
function getVersion() {
  return wasm.version();
}
function analyzeQuery(sql, optionsOrDialect = {}) {
  try {
    const normalized = normalizeAnalyzeQueryOptions(optionsOrDialect);
    if (typeof wasm.analyze_query_value === "function") {
      return decodeWasmPayload(
        wasm.analyze_query_value(sql, normalized)
      );
    }
    if (typeof wasm.analyze_query === "function") {
      return JSON.parse(
        wasm.analyze_query(sql, JSON.stringify(normalized))
      );
    }
    return {
      success: false,
      error: "analyze_query not available in this WASM build"
    };
  } catch (error) {
    return queryAnalysisFailure("analyzeQuery", error);
  }
}
function annotateTypes(sql, dialect = "generic", schema) {
  try {
    const schemaJson = schema ? JSON.stringify(schema) : "";
    if (typeof wasm.annotate_types_value === "function") {
      return decodeWasmPayload(
        wasm.annotate_types_value(sql, dialect, schemaJson)
      );
    }
    if (typeof wasm.annotate_types === "function") {
      return JSON.parse(
        wasm.annotate_types(sql, dialect, schemaJson)
      );
    }
    return {
      success: false,
      error: "annotate_types not available in this WASM build"
    };
  } catch (error) {
    return {
      success: false,
      error: `WASM annotate_types failed: ${errorMessage(error)}`
    };
  }
}
class Polyglot {
  static instance = null;
  constructor() {
  }
  /**
   * Get or create the Polyglot instance.
   * The WASM module is automatically initialized on import.
   */
  static getInstance() {
    if (!Polyglot.instance) {
      Polyglot.instance = new Polyglot();
    }
    return Polyglot.instance;
  }
  /**
   * Transpile SQL from one dialect to another.
   *
   * @remarks
   * Use {@link Polyglot.getDialects} to inspect available dialects.
   */
  transpile(sql, read, write, options) {
    return transpile(sql, read, write, options);
  }
  /**
   * Parse SQL into an AST.
   */
  parse(sql, dialect = "generic") {
    return parse(sql, dialect);
  }
  /**
   * Parse a standalone SQL data type.
   */
  parseDataType(sql, dialect = "generic") {
    return parseDataType(sql, dialect);
  }
  /**
   * Tokenize SQL into a token stream.
   */
  tokenize(sql, dialect = "generic") {
    return tokenize(sql, dialect);
  }
  /**
   * Generate SQL from an AST.
   */
  generate(ast2, dialect = "generic") {
    return generate(ast2, dialect);
  }
  /**
   * Generate SQL from a standalone DataType AST node.
   */
  generateDataType(dataType, dialect = "generic") {
    return generateDataType(dataType, dialect);
  }
  /**
   * Format SQL.
   */
  format(sql, dialect = "generic") {
    return format(sql, dialect);
  }
  /**
   * Format SQL with explicit guard limits.
   */
  formatWithOptions(sql, dialect = "generic", options = {}) {
    return formatWithOptions(sql, dialect, options);
  }
  /**
   * Get supported dialects in this build.
   */
  getDialects() {
    return getDialects();
  }
  /**
   * Get library version.
   */
  getVersion() {
    return getVersion();
  }
  /**
   * Parse SQL and annotate the AST with inferred type information.
   */
  annotateTypes(sql, dialect = "generic", schema) {
    return annotateTypes(sql, dialect, schema);
  }
  analyzeQuery(sql, optionsOrDialect = {}) {
    return analyzeQuery(sql, normalizeAnalyzeQueryOptions(optionsOrDialect));
  }
}
const index = {
  init,
  isInitialized,
  transpile,
  parse,
  parseDataType,
  tokenize,
  generate,
  generateDataType,
  format,
  annotateTypes,
  analyzeQuery,
  getDialects,
  getVersion,
  lineage,
  lineageAt,
  lineageAtWithSchema,
  lineageWithSchema,
  outputColumns,
  outputColumnsWithSchema,
  getSourceTables,
  openLineageColumnLineage,
  openLineageJobEvent,
  openLineageRunEvent,
  diff,
  hasChanges,
  changesOnly,
  plan,
  Dialect,
  Polyglot,
  compat: compat2
};
exports.CaseBuilder = CaseBuilder;
exports.DeleteBuilder = DeleteBuilder;
exports.Dialect = Dialect;
exports.Expr = Expr;
exports.InsertBuilder = InsertBuilder;
exports.MergeBuilder = MergeBuilder;
exports.Polyglot = Polyglot;
exports.SelectBuilder = SelectBuilder;
exports.SetOpBuilder = SetOpBuilder;
exports.UpdateBuilder = UpdateBuilder;
exports.ValidationSeverity = ValidationSeverity;
exports.WindowDefBuilder = WindowDefBuilder;
exports.abs = abs;
exports.alias = alias;
exports.analyzeQuery = analyzeQuery;
exports.and = and;
exports.annotateTypes = annotateTypes;
exports.ast = index$1;
exports.avg = avg;
exports.boolean = boolean;
exports.caseOf = caseOf;
exports.caseWhen = caseWhen;
exports.cast = cast;
exports.ceil = ceil;
exports.changesOnly = changesOnly;
exports.coalesce = coalesce;
exports.col = col;
exports.compat = compat2;
exports.concatWs = concatWs;
exports.condition = condition;
exports.count = count;
exports.countDistinct = countDistinct;
exports.currentDate = currentDate;
exports.currentTime = currentTime;
exports.currentTimestamp = currentTimestamp;
exports.default = index;
exports.del = del;
exports.deleteFrom = deleteFrom;
exports.denseRank = denseRank;
exports.diff = diff;
exports.except = except;
exports.exp = exp;
exports.extract = extract;
exports.findAll = findAll;
exports.floor = floor;
exports.format = format;
exports.formatWithOptions = formatWithOptions;
exports.func = func;
exports.generate = generate;
exports.generateDataType = generateDataType;
exports.getColumns = getColumns;
exports.getDialects = getDialects;
exports.getInferredType = getInferredType;
exports.getSourceTables = getSourceTables;
exports.getVersion = getVersion;
exports.greatest = greatest;
exports.hasChanges = hasChanges;
exports.ifNull = ifNull;
exports.init = init;
exports.initcap = initcap;
exports.insert = insert;
exports.insertInto = insertInto;
exports.intersect = intersect;
exports.isColumn = isColumn;
exports.isFunction = isFunction;
exports.isInitialized = isInitialized;
exports.isLiteral = isLiteral;
exports.isSelect = isSelect;
exports.least = least;
exports.length = length;
exports.lineage = lineage;
exports.lineageAt = lineageAt;
exports.lineageAtWithSchema = lineageAtWithSchema;
exports.lineageWithSchema = lineageWithSchema;
exports.lit = lit;
exports.ln = ln;
exports.lower = lower;
exports.ltrim = ltrim;
exports.max = max;
exports.mergeInto = mergeInto;
exports.min = min;
exports.not = not;
exports.nullIf = nullIf;
exports.openLineageColumnLineage = openLineageColumnLineage;
exports.openLineageJobEvent = openLineageJobEvent;
exports.openLineageRunEvent = openLineageRunEvent;
exports.or = or;
exports.outputColumns = outputColumns;
exports.outputColumnsWithSchema = outputColumnsWithSchema;
exports.parse = parse;
exports.parseDataType = parseDataType;
exports.plan = plan;
exports.power = power;
exports.rank = rank;
exports.renameColumns = renameColumns;
exports.replace = replace;
exports.reverse = reverse;
exports.round = round;
exports.rowNumber = rowNumber;
exports.rtrim = rtrim;
exports.select = select;
exports.sign = sign;
exports.sqlExpr = sqlExpr;
exports.sqlNull = sqlNull;
exports.sqrt = sqrt;
exports.star = star;
exports.subquery = subquery;
exports.substring = substring;
exports.sum = sum;
exports.table = table;
exports.tokenize = tokenize;
exports.transform = transform;
exports.transpile = transpile;
exports.trim = trim;
exports.union = union;
exports.unionAll = unionAll;
exports.update = update;
exports.upper = upper;
exports.validate = validate;
exports.validateWithSchema = validateWithSchema;
exports.walk = walk;
module.exports = index;
Object.assign(module.exports, exports);
