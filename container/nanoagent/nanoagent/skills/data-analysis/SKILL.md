---
name: data-analysis
description: "Use when exploring, analyzing, or deriving insights from datasets. Always checks data shape and quality before any statistical analysis."
tags: [data, analysis, statistics, python, visualization, pandas]
related_skills: [systematic-debugging]
version: 1.0.0
author: nanocrew
---

# Data Analysis

Data analysis is the process of turning raw data into defensible conclusions. The most common failure mode in data analysis is not bad statistics — it is good statistics applied to data that was not properly understood. This skill enforces a strict protocol: understand the data shape and quality first, ask the right questions before writing any code, and report results with context (sample size, confidence level, caveats).

Every analysis produced by this skill is reproducible, explicitly scoped, and honest about its limitations.

## When to Use

Trigger this skill when:

- A user asks to "analyze", "explore", "summarize", or "find insights" in a dataset
- A CSV, database table, JSON file, or API response is provided for examination
- A user asks a question that requires counting, aggregating, or correlating data
- A user wants to know "why" something changed in metrics or a chart
- A user asks for trends, patterns, or predictions from historical data

---

## The Five Questions

Answer all five before writing a single line of analysis code. These questions are not bureaucratic overhead — they determine whether your analysis will be meaningful or misleading.

### 1. What is the unit of observation?

What does one row (or one record) represent? A user? A transaction? A session? A day? An event?

If you are not sure, examine the primary key structure and look for natural groupings:

```python
# python_repl
import pandas as pd

df = pd.read_csv("events.csv")
print(df.dtypes)
print(df.head(10))
print(f"Shape: {df.shape}")
print(f"Columns: {list(df.columns)}")

# Is each row a unique event?
print(f"Unique event_ids: {df['event_id'].nunique()} / {len(df)} rows")
```

### 2. What time period does this data cover?

Data from the last 7 days behaves differently from data from the last 3 years. Seasonality, trends, and one-time events all depend on the time window.

```python
# python_repl
print(df['created_at'].min(), "to", df['created_at'].max())
print(f"Date range: {(df['created_at'].max() - df['created_at'].min()).days} days")

# Are there gaps?
daily_counts = df.resample('D', on='created_at').size()
print(daily_counts[daily_counts == 0])  # Days with zero records
```

### 3. How was the data collected?

Collection method determines the presence and direction of sampling bias. Ask:
- Is this all data, or a sample? How was the sample drawn?
- Was there a change in collection methodology during the period?
- Is there a selection effect — were only certain records kept?

Example: if analyzing "customer satisfaction scores", ask whether scores were collected for all customers or only those who responded to an optional survey (survivor bias).

### 4. What question are you actually trying to answer?

State the research question in one specific, falsifiable sentence. Vague questions produce vague conclusions.

| Vague | Specific |
|---|---|
| "What's happening with revenue?" | "Did monthly recurring revenue grow faster in Q1 2025 than Q1 2024?" |
| "Why are users churning?" | "Is there a statistically significant difference in churn rate between users who completed onboarding and those who did not?" |
| "Is the feature working?" | "Did the feature-flagged group have a higher 7-day retention rate than the control group, with p < 0.05?" |

### 5. What would a meaningful result look like?

Before computing anything, decide: what result would change your decision, and what result would not? If no plausible result would change what you do, the analysis is not worth doing.

---

## Phase 1 — Understand the Data Shape

Never skip this phase. Running an average on a column you have not looked at will produce a number that may be meaningless or actively misleading.

### Load and inspect

```python
# python_repl
import pandas as pd
import numpy as np

df = pd.read_csv("orders.csv", parse_dates=["created_at", "shipped_at"])

# Shape and types
print(df.shape)          # rows, columns
print(df.dtypes)         # verify types are as expected
print(df.head())         # spot-check raw values
print(df.describe())     # quick stats: count, mean, std, min, max, quartiles
```

### Check for nulls

```python
# python_repl
null_counts = df.isnull().sum()
null_pct = (null_counts / len(df) * 100).round(2)
null_report = pd.DataFrame({'count': null_counts, 'pct': null_pct})
print(null_report[null_report['count'] > 0].sort_values('pct', ascending=False))
```

Interpret what nulls mean. A null `shipped_at` may mean the order was not yet shipped — excluding these rows would bias a shipping-time analysis. A null `email` may mean data was collected before email was required — these rows may need different handling.

### Check for duplicates

```python
# python_repl
print(f"Total rows: {len(df)}")
print(f"Unique order_ids: {df['order_id'].nunique()}")

dupes = df[df.duplicated(subset=['order_id'], keep=False)]
print(f"Duplicate rows: {len(dupes)}")
if len(dupes) > 0:
    print(dupes.head(10))
```

Understand *why* duplicates exist before dropping them. In event logs, duplicates may be legitimate (a user clicked twice). In an orders table, duplicates indicate a data pipeline bug.

### Check distributions

```python
# python_repl

# Numeric: look for outliers and skew
for col in ['order_value', 'item_count', 'shipping_days']:
    series = df[col].dropna()
    print(f"\n{col}:")
    print(f"  mean={series.mean():.2f}, median={series.median():.2f}, std={series.std():.2f}")
    print(f"  min={series.min()}, max={series.max()}")
    print(f"  p95={series.quantile(0.95):.2f}, p99={series.quantile(0.99):.2f}")
    skew = series.skew()
    print(f"  skew={skew:.2f} ({'right-skewed' if skew > 1 else 'left-skewed' if skew < -1 else 'roughly symmetric'})")

# Categorical: check cardinality and value frequency
for col in ['status', 'country', 'payment_method']:
    print(f"\n{col}: {df[col].nunique()} unique values")
    print(df[col].value_counts(normalize=True).head(10).round(3))
```

**Right-skewed distributions** (long tail to the right, e.g. order values, session duration) mean the mean is inflated by outliers. Prefer median for "typical value" in these cases.

### Shape Checklist

- [ ] Shape (rows, columns) confirmed
- [ ] Column types are as expected (dates parsed as dates, not strings)
- [ ] Null counts and null percentages documented for every column
- [ ] Nulls are interpreted (not just counted)
- [ ] Duplicates checked and accounted for
- [ ] Numeric distributions inspected: mean, median, std, p95, p99, skew
- [ ] Categorical distributions inspected: cardinality, value frequencies

---

## Phase 2 — Analyze

Only now, with the data fully understood, run the actual analysis.

### Aggregations and grouping

```python
# python_repl

# Revenue by country with sample size
revenue_by_country = df.groupby('country').agg(
    total_revenue=('order_value', 'sum'),
    avg_order_value=('order_value', 'median'),  # median for skewed data
    order_count=('order_id', 'count'),
    unique_customers=('customer_id', 'nunique')
).sort_values('total_revenue', ascending=False)

print(revenue_by_country)
```

Always include sample size (`n`) in any reported aggregate. A country with $50,000 revenue from 3 orders is not comparable to a country with $50,000 revenue from 3,000 orders.

### Time series

```python
# python_repl

# Weekly trend with rolling average
weekly = df.resample('W', on='created_at')['order_value'].agg(['sum', 'count', 'median'])
weekly.columns = ['revenue', 'orders', 'median_order']
weekly['revenue_7d_ma'] = weekly['revenue'].rolling(4).mean()
print(weekly.tail(12))
```

### Comparing groups

When comparing two groups (e.g. A/B test, feature flag cohorts), always perform a statistical significance test. Never claim a difference is real without one.

```python
# python_repl
from scipy import stats

control = df[df['group'] == 'control']['order_value'].dropna()
treatment = df[df['group'] == 'treatment']['order_value'].dropna()

# Mann-Whitney U (non-parametric, appropriate for skewed distributions)
statistic, p_value = stats.mannwhitneyu(control, treatment, alternative='two-sided')

print(f"Control:   n={len(control)}, median={control.median():.2f}")
print(f"Treatment: n={len(treatment)}, median={treatment.median():.2f}")
print(f"p-value: {p_value:.4f}")
print(f"Result: {'Statistically significant (p<0.05)' if p_value < 0.05 else 'Not statistically significant'}")
```

---

## Phase 3 — Output Results

All results emitted from this skill include:

1. **Sample size (n):** How many records were analyzed
2. **Time period:** The date range the data covers
3. **Confidence level or p-value:** For statistical claims
4. **Caveats:** What the analysis cannot tell you

Use `emit_artifact` for charts and tables intended for the user:

```python
# python_repl — generate chart for emit_artifact
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(10, 5))
weekly['revenue'].plot(ax=ax, label='Weekly revenue')
weekly['revenue_7d_ma'].plot(ax=ax, label='4-week moving average', linestyle='--')
ax.set_title(f"Weekly Revenue (n={len(df):,} orders, {df['created_at'].min().date()} to {df['created_at'].max().date()})")
ax.set_xlabel("Week")
ax.set_ylabel("Revenue ($)")
ax.legend()
plt.tight_layout()
plt.savefig("revenue_trend.png", dpi=150)

# Then emit_artifact: revenue_trend.png
```

**Result summary template:**

```
Analysis: [What was measured]
Period: [Date range]
Sample: n=[number] [unit of observation]
Exclusions: [What was excluded and why]

Finding: [Plain English finding]
Confidence: [p-value or confidence interval, or "descriptive only"]

Caveats:
- [Limitation 1]
- [Limitation 2]
```

---

## Common Mistakes

### Correlation vs. Causation

If A and B move together, A does not cause B. Ice cream sales and drowning rates both peak in summer — they are correlated via a third variable (temperature), not causally related.

Never use "causes" language in a correlational analysis. Use "associated with", "positively correlated with", or "predicts" instead. Reserve causal claims for randomized controlled experiments.

### Survivorship Bias

If you analyze only records that "survived" some filter, your conclusions apply only to survivors — not to the full population. Analyzing only customers who are still active will produce systematically biased churn predictions. Analyzing only products still in the catalog will miss discontinued products. Always ask: what data is missing from this dataset because of how it was collected?

### P-hacking

Running 50 different statistical tests on the same dataset and reporting only the 2-3 that came back significant (p < 0.05) is not analysis — it is cherry-picking. At p < 0.05, you expect roughly 1 in 20 tests to be a false positive by chance.

Mitigations:
- Pre-register the hypothesis before running the test
- Use a Bonferroni correction when running multiple tests: divide the alpha threshold by the number of tests (`alpha = 0.05 / n_tests`)
- Report all tests run, not just the significant ones

### Aggregation Bias (Simpson's Paradox)

A trend that appears in aggregated data can disappear or reverse when the data is segmented. Always segment before concluding.

Example: a new checkout flow has higher overall conversion rate than the old one, but when segmented by device type, mobile conversion actually dropped. The aggregate improvement was driven entirely by desktop users.

```python
# python_repl — always check segment-level results
for segment in df['device_type'].unique():
    subset = df[df['device_type'] == segment]
    rate = subset['converted'].mean()
    n = len(subset)
    print(f"{segment}: {rate:.1%} conversion (n={n:,})")
```

### Using Mean for Skewed Data

Revenue, time-on-site, file size, and most user behavior metrics are right-skewed. The mean is pulled up by extreme values (outliers) and does not represent the "typical" case. Use median for typical value, and report the distribution (p25, p75, p95) when the shape matters.

### Ignoring Sample Size

A 40% conversion rate from 5 users and a 40% conversion rate from 50,000 users are not the same thing. Always report n. Always ask whether the sample is large enough to draw the conclusion being claimed.

---

## Verification Checklist

**Before analysis**
- [ ] Five questions answered: unit of observation, time period, collection method, research question, meaningful result threshold
- [ ] Data loaded and shape confirmed (rows, columns, dtypes)
- [ ] Null counts and interpretation documented
- [ ] Duplicates checked and handled
- [ ] Distributions inspected: skew identified, outliers noted

**During analysis**
- [ ] Aggregations include sample size (n) alongside the metric
- [ ] Skewed distributions use median, not mean, for "typical value"
- [ ] Group comparisons use a significance test
- [ ] Time series are checked for data gaps before trend conclusions

**In the output**
- [ ] Result includes: metric, time period, sample size, confidence level or p-value
- [ ] Caveats are stated explicitly (what this analysis cannot tell you)
- [ ] Causal language avoided unless data is from a randomized experiment
- [ ] Survivorship bias considered and addressed
- [ ] Multiple tests reported in full, not cherry-picked

---

## Quick Reference

```
PHASE 1: UNDERSTAND THE DATA
  Five questions first
  → load + inspect shape, dtypes, head
  → null counts + interpretation
  → duplicate check
  → distributions: mean, median, std, p95, skew

PHASE 2: ANALYZE
  → aggregations with sample size
  → time series with gap check
  → group comparisons with significance test

PHASE 3: OUTPUT
  → emit_artifact for charts
  → always include: n, period, confidence, caveats
  → no causal claims without RCT

COMMON TRAPS
  → correlation ≠ causation
  → survivorship bias
  → p-hacking (run all tests, not just significant ones)
  → Simpson's paradox (segment before concluding)
  → mean on skewed data (use median)
```
