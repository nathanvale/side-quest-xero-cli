# Workflow: New Quarter Setup

Prepare a brand-new quarter so extraction and reconciliation can run without blockers.

## Goal

- Confirm the quarter is valid for today's date
- Ensure the correct QIF file is present and named correctly
- Register/refresh quarter status in `data/quarters.json`

## Step 1: Resolve quarter and dates

```bash
# Concrete example
python3 scripts/manage-quarters.py dates 1 26
python3 scripts/manage-quarters.py filename 1 26

# Template
python3 scripts/manage-quarters.py dates "$Q" "$FY"
python3 scripts/manage-quarters.py filename "$Q" "$FY"
```
Never execute placeholder literals (`Q`, `FY`) directly.

## Step 2: Time guard (prevent future-quarter confusion)

```bash
# Concrete example
python3 scripts/manage-quarters.py gate 1 26

# Template
python3 scripts/manage-quarters.py gate "$Q" "$FY"
```

If the quarter is still active or QIF is missing, gate will stop with an actionable message.

## Step 3: Optional manual verify (if user asks)

```bash
# Concrete example
QIF_FILE="data/$(python3 scripts/manage-quarters.py qif-file 1 26)"
python3 scripts/parse-qif.py "$QIF_FILE" | head -4

# Template
QIF_FILE="data/$(python3 scripts/manage-quarters.py qif-file "$Q" "$FY")"
python3 scripts/parse-qif.py "$QIF_FILE" | head -4
```

`gate` already enforces completion + presence checks. This step is only for explicit user confidence/inspection.

## Step 4: Refresh quarter registry

```bash
python3 scripts/manage-quarters.py init
python3 scripts/manage-quarters.py status
```

If already imported into Xero, mark it:

```bash
# Concrete example
python3 scripts/manage-quarters.py mark-imported 1 26

# Template
python3 scripts/manage-quarters.py mark-imported "$Q" "$FY"
```

## Success Criteria

- [ ] Quarter is complete (not in the future)
- [ ] QIF file exists with correct naming
- [ ] Gate check passed (`manage-quarters.py gate`)
- [ ] Quarter appears in `manage-quarters.py status`
- [ ] User can proceed to extract
