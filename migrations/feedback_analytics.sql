-- ============================================================
-- AutoVal feedback analytics queries
-- Run in Supabase SQL Editor
-- ============================================================


-- ── 1. Overall summary ─────────────────────────────────────────────────────

SELECT
  COUNT(*)                                                           AS total_prompted,
  COUNT(*) FILTER (WHERE responded_at IS NOT NULL)                   AS total_responded,
  COUNT(*) FILTER (WHERE actual_sale_price IS NOT NULL)              AS with_sale_price,
  ROUND(
    COUNT(*) FILTER (WHERE responded_at IS NOT NULL)::numeric
    / NULLIF(COUNT(*), 0) * 100, 1
  )                                                                  AS response_rate_pct,
  ROUND(AVG(variance_pct) FILTER (WHERE variance_pct IS NOT NULL), 1) AS avg_variance_pct,
  ROUND(AVG(ABS(variance_pct)) FILTER (WHERE variance_pct IS NOT NULL), 1) AS avg_abs_error_pct
FROM scan_outcomes;


-- ── 2. Monthly trend — are we getting more accurate? ───────────────────────

SELECT
  TO_CHAR(DATE_TRUNC('month', responded_at), 'Mon YYYY')   AS month,
  COUNT(*) FILTER (WHERE actual_sale_price IS NOT NULL)    AS responses_with_price,
  ROUND(AVG(variance_pct)          FILTER (WHERE variance_pct IS NOT NULL), 1) AS avg_variance_pct,
  ROUND(AVG(ABS(variance_pct))     FILTER (WHERE variance_pct IS NOT NULL), 1) AS avg_abs_error_pct,
  ROUND(MIN(variance_pct)          FILTER (WHERE variance_pct IS NOT NULL), 1) AS min_variance_pct,
  ROUND(MAX(variance_pct)          FILTER (WHERE variance_pct IS NOT NULL), 1) AS max_variance_pct
FROM scan_outcomes
WHERE responded_at IS NOT NULL
GROUP BY DATE_TRUNC('month', responded_at)
ORDER BY DATE_TRUNC('month', responded_at);


-- ── 3. Accuracy by make + model (min 3 responses for reliability) ──────────

SELECT
  s.make,
  s.model,
  COUNT(*)                                                    AS responses,
  ROUND(AVG(o.variance_pct), 1)                              AS avg_variance_pct,
  ROUND(AVG(ABS(o.variance_pct)), 1)                         AS avg_abs_error_pct,
  ROUND(MIN(o.variance_pct), 1)                              AS min_variance_pct,
  ROUND(MAX(o.variance_pct), 1)                              AS max_variance_pct,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.variance_pct)::numeric, 1) AS median_variance_pct
FROM scan_outcomes o
JOIN scans s ON s.id = o.scan_id
WHERE o.actual_sale_price IS NOT NULL
GROUP BY s.make, s.model
HAVING COUNT(*) >= 3
ORDER BY avg_abs_error_pct ASC;


-- ── 4. Outcome distribution ────────────────────────────────────────────────

SELECT
  outcome,
  COUNT(*) AS count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 1) AS pct
FROM scan_outcomes
WHERE responded_at IS NOT NULL
GROUP BY outcome
ORDER BY count DESC;


-- ── 5. Days-to-sell by make/model ──────────────────────────────────────────

SELECT
  s.make,
  s.model,
  COUNT(*)                                                         AS sold_count,
  ROUND(AVG(o.days_to_sell) FILTER (WHERE o.days_to_sell IS NOT NULL), 0) AS avg_days_to_sell,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.days_to_sell)::numeric, 0) AS median_days_to_sell
FROM scan_outcomes o
JOIN scans s ON s.id = o.scan_id
WHERE o.outcome = 'sold'
  AND o.days_to_sell IS NOT NULL
GROUP BY s.make, s.model
HAVING COUNT(*) >= 3
ORDER BY avg_days_to_sell ASC;


-- ── 6. Top contributors (for future gamification) ──────────────────────────

SELECT
  user_id,
  COUNT(*) AS contributions,
  MAX(responded_at) AS last_contributed_at
FROM scan_outcomes
WHERE responded_at IS NOT NULL
  AND user_id IS NOT NULL
GROUP BY user_id
ORDER BY contributions DESC
LIMIT 20;
