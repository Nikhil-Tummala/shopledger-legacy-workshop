'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const store = require('../lib/store');
const pricing = require('../lib/pricing');
const invoice = require('../lib/invoice');
const reports = require('../lib/reports');
const ordersRouter = require('../routes/orders');

function freshDb() {
  return {
    nextOrderId: 2001,
    nextSettlementId: 1,
    products: [{ id: 1, sku: 'RICE-1', name: 'Rice', hsn: '1006', price: 1000, stock: 10, reserved: 0 }],
    orders: [],
    customers: [],
    settlements: [],
    auditLog: []
  };
}

function postOrderInMemory(body) {
  const db = freshDb();
  const originalRead = store.read;
  const originalWrite = store.write;
  let writtenDb;
  store.read = () => db;
  store.write = (value) => { writtenDb = value; };

  try {
    const layer = ordersRouter.stack.find((entry) => entry.route &&
      entry.route.path === '/orders' && entry.route.methods.post);
    assert.ok(layer, 'POST /orders route exists');
    const handler = layer.route.stack[0].handle;
    let statusCode = 200;
    let payload;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; }
    };
    handler({ body }, res);
    return { db, writtenDb, statusCode, order: payload };
  } finally {
    store.read = originalRead;
    store.write = originalWrite;
  }
}

test('invoice uses the billed HSN GST rate and matches the order total', () => {
  const result = postOrderInMemory({ items: [{ id: 1, qty: 1 }] });
  assert.equal(result.statusCode, 201);
  assert.equal(result.order.total, 1050);
  assert.equal(result.order.tax, 50);
  assert.equal(result.order.items[0].hsn, '1006');

  const invoiceFigures = invoice.computeInvoiceFigures(result.order);
  assert.equal(invoiceFigures.tax, 50);
  assert.equal(invoiceFigures.cgst, 25);
  assert.equal(invoiceFigures.sgst, 25);
  assert.equal(invoiceFigures.total, result.order.total);
  assert.equal(invoiceFigures.rows[0].gstPercent, 5);
  assert.equal(invoiceFigures.rows[0].lineTax, 50);
});

test('invoice figures match the billed order total and GST breakdown', () => {
  const result = postOrderInMemory({ items: [{ id: 1, qty: 1 }] });
  const invoiceFigures = invoice.computeInvoiceFigures(result.order);

  assert.equal(invoiceFigures.tax, result.order.tax);
  assert.equal(invoiceFigures.cgst + invoiceFigures.sgst, result.order.tax);
  assert.equal(invoiceFigures.total, result.order.total);
});

test('invoice coupon discount and GST match the billed order', () => {
  const result = postOrderInMemory({ items: [{ id: 1, qty: 1 }], coupon: 'SAVE10' });
  assert.equal(result.statusCode, 201);
  assert.deepEqual(
    [result.order.subtotal, result.order.discount, result.order.tax, result.order.total],
    [1000, 100, 45, 945]
  );

  const invoiceFigures = invoice.computeInvoiceFigures(result.order);
  assert.deepEqual(
    [invoiceFigures.subtotal, invoiceFigures.discount, invoiceFigures.tax, invoiceFigures.total],
    [1000, 100, 45, 945]
  );
});

test('reconciliation reports matching invoice figures for an in-memory order', () => {
  const result = postOrderInMemory({ items: [{ id: 1, qty: 1 }] });
  const reconciliation = reports.getGstReconciliation({ orders: [result.order] });

  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].ledgerTax, 50);
  assert.equal(reconciliation.rows[0].invoiceTax, 50);
  assert.equal(reconciliation.rows[0].invoiceTotal, 1050);
});

test('order pricing applies the HSN rate and splits GST', () => {
  const totals = pricing.computeTotals([
    { id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }
  ], '');

  assert.equal(totals.tax, 50);
  assert.equal(totals.cgst, 25);
  assert.equal(totals.sgst, 25);
  assert.equal(totals.total, 1050);
});
