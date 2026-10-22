import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTool, forbiddenByArgs } from "../src/policy/risk.ts";
import { luhn, redact, scanSensitive } from "../src/policy/sensitive.ts";
import { paymentAmount } from "../src/agent/gate.ts";
import { clickRisk } from "../src/tools/builtin/browser.ts";
import { isPrivate } from "../src/tools/builtin/web.ts";
import { inWindow } from "../src/util.ts";

test("classifies connector tools by verb and MCP hints", () => {
  assert.equal(classifyTool("gmail__search_messages"), "read");
  assert.equal(classifyTool("list_invoices"), "read");
  assert.equal(classifyTool("get_payment_status"), "read");
  assert.equal(classifyTool("send_email"), "external");
  assert.equal(classifyTool("createIssue"), "external");
  assert.equal(classifyTool("slack__post_message"), "external");
  assert.equal(classifyTool("delete_file"), "delete");
  assert.equal(classifyTool("archive_thread"), "delete");
  assert.equal(classifyTool("create_payment_link"), "payment");
  assert.equal(classifyTool("refund_charge"), "payment");
  assert.equal(classifyTool("docusign__sign_envelope"), "sign");
  assert.equal(classifyTool("frobnicate"), "external", "unknown verbs are conservative");
  assert.equal(classifyTool("frobnicate", "", { readOnlyHint: true }), "read");
  assert.equal(classifyTool("update_widget", "", { destructiveHint: true }), "delete");
});

test("hard limits: trading and money movement are forbidden, reads of them are not", () => {
  assert.equal(classifyTool("buy_stock"), "forbidden");
  assert.equal(classifyTool("place_market_order"), "forbidden");
  assert.equal(classifyTool("create_transfer"), "forbidden");
  assert.equal(classifyTool("stripe__create_payout"), "forbidden");
  assert.equal(classifyTool("wire_money"), "forbidden");
  assert.equal(classifyTool("list_transfers"), "read");
  assert.equal(classifyTool("get_trade_history"), "read");
  assert.match(forbiddenByArgs("http_request", { body: "please buy 10 shares of AAPL" }) ?? "", /off-limits/);
  assert.match(forbiddenByArgs("browser_type", { text: "transfer $5,000 to savings" }) ?? "", /off-limits/);
  assert.equal(forbiddenByArgs("email__send", { body: "Thanks for the meeting!" }), null);
});

test("sensitive data scanner", () => {
  assert.ok(luhn("4111111111111111"));
  assert.ok(!luhn("4111111111111112"));
  assert.deepEqual(scanSensitive("card 4111 1111 1111 1111 exp 12/28").map((f) => f.kind), ["card"]);
  assert.equal(scanSensitive("order #1234567890123 shipped").length, 0, "non-Luhn digit runs are fine");
  assert.deepEqual(scanSensitive("SSN 123-45-6789").map((f) => f.kind), ["ssn"]);
  assert.deepEqual(scanSensitive("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz").map((f) => f.kind), ["secret"]);
  assert.deepEqual(scanSensitive("IBAN GB82 WEST 1234 5698 7654 32").map((f) => f.kind), ["iban"]);
  assert.equal(redact("pay with 4111111111111111"), "pay with [redacted …1111]");
  assert.equal(redact("token=hunter2hunter2", ["hunter2hunter2"]), "token=[secret]");
});

test("payment amounts", () => {
  assert.equal(paymentAmount({ amount: 49.99 }), 49.99);
  assert.equal(paymentAmount({ unit_amount: 5000 }), 50);
  assert.equal(paymentAmount({ order: { total: "120" } }), 120);
  assert.equal(paymentAmount({ note: "hi" }), null);
});

test("browser click risk from element label", () => {
  assert.equal(clickRisk("Place order"), "payment");
  assert.equal(clickRisk("Pay $42.00"), "payment");
  assert.equal(clickRisk("Finish signing"), "sign");
  assert.equal(clickRisk("Delete account"), "delete");
  assert.equal(clickRisk("Send"), "external");
  assert.equal(clickRisk("Pricing"), "read");
  assert.equal(clickRisk("Next page"), "read");
});

test("SSRF guard recognizes private ranges", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "100.100.1.1"]) assert.ok(isPrivate(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) assert.ok(!isPrivate(ip), ip);
});

test("time windows wrap past midnight", () => {
  assert.ok(inWindow(23 * 60, "21:00", "07:00"));
  assert.ok(inWindow(3 * 60, "21:00", "07:00"));
  assert.ok(!inWindow(12 * 60, "21:00", "07:00"));
  assert.ok(inWindow(9 * 60, "08:00", "20:00"));
  assert.ok(!inWindow(20 * 60, "08:00", "20:00"));
});
