// Glue for "Plan the day" in 00 Working day; worker.js and OFFICES are pasted above it. One item per slot.
const count = Math.max(1, Math.min(40, Math.floor(Number($('Config').first().json.count)) || 12));
return planSlots(count, OFFICES, Math.random).map((slot, i) => ({ json: { slot: i + 1, office_id: slot.office_id } }));
