import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentRemarks, validateAllocations } from '../../lib/payment-allocations.js';

test('a payment remark survives validation on every payment line', () => {
  const lines = validateAllocations([
    { method: 'cash', amount: 300, cash_tendered: 300, notes: '  paid by son  ' },
    { method: 'online', amount: 200, notes: '  paid by son  ' },
  ], 500);
  assert.deepEqual(lines.map((line) => line.notes), ['paid by son', 'paid by son']);
});

test('bill and order details show each distinct remark once, oldest first', () => {
  const payments = [{ notes: 'paid by son' }, { notes: '' }, { notes: null }];
  const allocations = [{ notes: 'paid by son' }, { notes: 'balance on Friday' }];
  assert.deepEqual(paymentRemarks(payments, allocations), ['paid by son', 'balance on Friday']);
  assert.deepEqual(paymentRemarks([], []), []);
});

test('WhatsApp bill and unpaid-bill messages carry the payment remarks', async () => {
  const { billMessage, creditBillsMessage } = await import('../../lib/whatsapp.js');
  const bill = {
    billNumber: 'B-1', createdAt: '2026-10-10T10:00:00Z', items: [{ name: 'Tea', quantity: 1, total: 50 }],
    totals: { subtotal: 50, grandTotal: 50, paid: 0, balance: 50 }, remarks: ['will pay Friday'],
  };
  assert.match(billMessage(bill), /Remark: will pay Friday/);
  assert.match(creditBillsMessage([{ bill_number: 'B-1', created_at: '2026-10-10T10:00:00Z', grand_total: 50, outstanding_amount: 50, items: [], remarks: ['will pay Friday'] }]), /Remark: will pay Friday/);
  assert.doesNotMatch(billMessage({ ...bill, remarks: [] }), /Remark/);
});
