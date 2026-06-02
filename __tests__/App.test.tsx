/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App, { capitalizeGroceryItemName, inferTaskDestinationHintForTest, normalizeMixedAiTaskRows } from '../App';

test('renders correctly', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  await ReactTestRenderer.act(() => {
    renderer?.unmount();
  });
});

test('grocery item capitalization is idempotent', () => {
  const cases: Array<[string, string]> = [
    ['eggs', 'Eggs'],
    ['Eggs', 'Eggs'],
    ['2 lb chicken', '2 lb Chicken'],
    ['2 lb Chicken', '2 lb Chicken'],
    ['iPhone charger', 'iPhone charger'],
  ];

  for (const [input, expected] of cases) {
    let value = input;
    for (let pass = 0; pass < 4; pass += 1) {
      value = capitalizeGroceryItemName(value);
    }
    expect(value).toBe(expected);
  }
});

test('mixed AI cleanup removes generic grocery suffixes from task rows', () => {
  const raw = 'adding rub kailyns back tomorrow at 6 eggs bacon bread';
  const rows = normalizeMixedAiTaskRows(
    [
      { text: 'Rub Kailyns back tomorrow at 6 bacon', tier: 'medium' },
      { text: 'Rub Kailyns back tomorrow at 6 eggs bacon bread', tier: 'medium' },
    ],
    raw,
    [{ name: 'eggs' }, { name: 'bacon' }, { name: 'bread' }],
  );

  expect(rows.map(row => row.text)).toEqual(['Rub Kailyns back tomorrow at 6']);
});

test('mixed AI cleanup uses parsed grocery rows instead of a fixed item list', () => {
  const raw = 'fix sink tomorrow at 6 flange wax ring supply hose';
  const rows = normalizeMixedAiTaskRows(
    [{ text: 'Fix sink tomorrow at 6 supply hose', tier: 'medium' }],
    raw,
    [{ name: 'flange' }, { name: 'wax ring' }, { name: 'supply hose' }],
  );

  expect(rows.map(row => row.text)).toEqual(['Fix sink tomorrow at 6']);
});

test('personal context can route project device terms to a list', () => {
  const lists: any[] = [
    { id: 'personal', name: 'To do', tasks: [] },
    { id: 'biomed', name: 'Biomed', tasks: [] },
  ];
  const hint = inferTaskDestinationHintForTest(
    'fix sv4 unit',
    lists,
    'personal',
    'Biomed is for SV4 units, SVA equipment, biomedical repairs, and device testing.',
  );

  expect(hint?.listId).toBe('biomed');
});
