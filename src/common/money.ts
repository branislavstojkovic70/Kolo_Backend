import { Prisma } from '@prisma/client';

type Money = Prisma.Decimal | string | number;

const D = (v: Money) => new Prisma.Decimal(v);

/** Decimal → the string form the FE expects. Never send floats to the FE. */
export const toFixed2 = (v: Money): string => D(v).toFixed(2);

export const sum = (values: Money[]): Prisma.Decimal =>
  values.reduce<Prisma.Decimal>(
    (acc, v) => acc.plus(D(v)),
    new Prisma.Decimal(0),
  );

/**
 * Platform fee, rounded half-up to cents. sellerAmount is always amount - fee,
 * so the two always add back up to exactly what the buyer paid.
 */
export function calcFee(amount: Money, feePercent: number) {
  const amountUsd = D(amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const feeUsd = amountUsd
    .times(D(feePercent))
    .dividedBy(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const sellerAmountUsd = amountUsd.minus(feeUsd);
  return { amountUsd, feeUsd, sellerAmountUsd };
}
