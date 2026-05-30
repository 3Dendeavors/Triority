/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App, { capitalizeGroceryItemName } from '../App';

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
