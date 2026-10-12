// Glue for "List the offices" in 06 Reconcile; OFFICES is pasted above it. One item per office for 03.
return OFFICES.map((o) => ({ json: { office_id: o.office_id, manager_id: o.manager_id } }));
