import { devRoutes as developmentRoutes } from './dev-routes';
import { devRoutes as productionRoutes } from './dev-routes.prod';

describe('development routes', () => {
  it('opens the design reference and leaves the empty path to the app', () => {
    expect(developmentRoutes.some((route) => route.path === '_design')).toBe(true);
    expect(developmentRoutes.some((route) => route.path === '')).toBe(false);
  });

  it('ships no development routes from the production replacement', () => {
    expect(productionRoutes).toEqual([]);
  });
});
