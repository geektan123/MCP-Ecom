# AI Worklog: Write-Safety & Concurrency Hardening

**Project:** Stalled Fulfillment Recovery MCP Server  
**Date:** August 5, 2026  
**Auditor / Reviewer:** DiligenceAI Team  

---

## Overview

Following the DiligenceAI review pass, a systematic code audit identified write-safety, transactional atomicity, concurrency, preview enforcement, and failure eligibility vulnerabilities across the fulfillment recovery codebase. 

This document logs the identified gaps, technical root causes, implemented architectural solutions, and test suite verification evidence.

---

## Audit Findings & Fixes Summary

### 1. Server-Enforced Prior Preview Requirement
* **Problem:** Direct execution of `retry_fulfillment` with `confirm=true` was permitted without a prior dry-run preview (`confirm=false`).
* **Fix Implemented:**
  - Added `preview_tokens` database table in `src/db.ts`.
  - When `confirm=false` (dry-run) is invoked, `createPreviewToken(...)` generates an opaque 10-minute token (`PRV-<uuid>`) and records the proposed action and attempts.
  - When `confirm=true` is invoked, `preview_token` is required. Direct calls without a token are rejected with `error: 'preview_required'`.
  - Tokens are validated for expiration, matching order ID, and one-time consumption (`validateAndConsumePreviewToken`).

### 2. Failure Reason Eligibility (e.g., `ORD-1031` Postal Code Validation)
* **Problem:** Order `ORD-1031` failed due to an invalid postal code ("Address validation failed for postal code"). Retrying fulfillment automatically would fail repeatedly because retrying cannot resolve invalid customer input data.
* **Fix Implemented:**
  - Implemented `isNonRetryableFailureReason(reason)` classifier in `src/tools/retry-fulfillment.ts`.
  - Automatically identifies data errors (address validation, postal/zip code failures, malformed payloads, out of stock, fraud flags).
  - Rejects automated retries for ineligible failure reasons with `error: 'not_retryable_data_error'` and instructs operators to use `escalate_order`.

### 3. Atomic Retry & Audit Commit
* **Problem:** `upsertFulfillment()` and `addAuditEntry()` previously ran as separate database calls. If a crash or network error occurred between calls, state was updated without an audit row.
* **Fix Implemented:**
  - Implemented `executeFulfillmentRetryTransaction(...)` in `src/data-store.ts`.
  - Encapsulates fulfillment task upsert, parent order status derivation, preview token consumption, and audit log creation inside a single PostgreSQL transaction (`BEGIN` ... `COMMIT` / `ROLLBACK`).

### 4. Concurrency Safety & Pessimistic Row Locking
* **Problem:** Simultaneous retry requests for the same order could race, resulting in duplicate retries and corrupt audit histories.
* **Fix Implemented:**
  - Applied PostgreSQL pessimistic row locking (`SELECT * FROM orders WHERE id = $1 FOR UPDATE`) inside the retry transaction.
  - Cooldown window (10 minutes) is evaluated directly inside the locked transaction under the DB clock (`NOW() - interval`).

### 5. Escalation Deduplication
* **Problem:** Rapid calls to `escalate_order` on the same order could spam the audit log with duplicate entries.
* **Fix Implemented:**
  - Implemented `addAuditEntryWithDedup(...)` in `src/data-store.ts`.
  - Checks if an `escalated` entry was recorded for the order within the last 30 minutes, returning `escalation_already_recorded` on rapid duplicates.

### 6. Collision-Safe ID Generation
* **Problem:** `generateId()` used an in-memory counter `let seq = Date.now() % 100000; ++seq` susceptible to collisions upon server restart or multi-instance deployment.
* **Fix Implemented:**
  - Replaced with `crypto.randomUUID()` (`FUL-<uuid>` and `AUD-<uuid>`). Widened schema columns from `VARCHAR(50)` to `VARCHAR(100)`.

---

## Test Verification Matrix

The test suite in `src/tools/safety.test.ts` was expanded to verify all write-safety guarantees against live PostgreSQL:

| Test Case | Objective | Result |
| :--- | :--- | :--- |
| `dry-run safety` | Verify `confirm=false` returns `preview_token` without mutating DB | **PASSED** |
| `direct confirmation block` | Verify `confirm=true` without token fails with `preview_required` | **PASSED** |
| `preview token execution` | Verify valid token permits execution and updates DB atomically | **PASSED** |
| `token reuse rejection` | Verify using an already consumed token fails with `preview_invalid` | **PASSED** |
| `ORD-1031 postal code` | Verify address validation failure is blocked with `not_retryable_data_error` | **PASSED** |
| `concurrency race test` | Launch 5 simultaneous parallel retries; verify exactly 1 succeeds | **PASSED** |
| `rate-limit cooldown` | Verify second retry within 10 minutes fails with `double_retry_prevented` | **PASSED** |
| `terminal order block` | Verify shipped/delivered/cancelled orders reject retries | **PASSED** |
| `escalation dedup` | Verify rapid duplicate escalations return `escalation_already_recorded` | **PASSED** |
