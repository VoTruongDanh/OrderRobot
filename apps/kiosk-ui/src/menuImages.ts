export function getMenuImage(itemId: string): string {
  const imageMap: Record<string, string> = {
    'ts-tranchau': '/menu-images/ts-tranchau.svg',
    'ts-oolong': '/menu-images/ts-oolong.svg',
    'tra-dao': '/menu-images/tra-dao.svg',
    'matcha-latte': '/menu-images/matcha-latte.svg',
    'ca-phe-muoi': '/menu-images/ca-phe-muoi.svg',
    'banh-flan': '/menu-images/banh-flan.svg',
    'tra-vai': '/menu-images/tra-vai.svg',
    'socola-da-xay': '/menu-images/socola-da-xay.svg',
  }

  return imageMap[itemId] ?? '/menu-images/default-drink.svg'
}
