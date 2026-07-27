export const MAX_INTEREST_FREE_INSTALLMENTS = 10;
export const MIN_INSTALLMENT_CENTS = 500;

export function createInterestFreeInstallments(
  totalCents,
  {
    maximum = MAX_INTEREST_FREE_INSTALLMENTS,
    minimumInstallmentCents = MIN_INSTALLMENT_CENTS,
  } = {},
) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 1) return [];

  const safeMaximum = Math.min(
    MAX_INTEREST_FREE_INSTALLMENTS,
    Number.isSafeInteger(maximum) ? Math.max(1, maximum) : MAX_INTEREST_FREE_INSTALLMENTS,
  );
  const safeMinimum = Number.isSafeInteger(minimumInstallmentCents)
    ? Math.max(1, minimumInstallmentCents)
    : MIN_INSTALLMENT_CENTS;
  const availableMaximum = Math.max(1, Math.min(safeMaximum, Math.floor(totalCents / safeMinimum)));

  return Array.from({ length: availableMaximum }, (_, index) => {
    const number = index + 1;
    return {
      number,
      totalCents,
      installmentCents: Math.ceil(totalCents / number),
      interestFree: true,
    };
  });
}

export function interestFreeInstallment(totalCents, number) {
  return createInterestFreeInstallments(totalCents)
    .find((option) => option.number === number) ?? null;
}
