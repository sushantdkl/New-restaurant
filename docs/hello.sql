SELECT d.id, d.deposit_date, d.business_day_id, je.entry_date, je.business_day_id AS je_day
FROM savings_deposits d
JOIN journal_entries je ON je.source_id = d.id AND je.source_type IN ('savings_deposit','savings_deposit_void')
WHERE d.id IN (4,59,60,61,62) ORDER BY d.id, je.id;
