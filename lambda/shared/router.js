/**
 * Compiles a route template and records the names of its `:parameters`.
 *
 * @param {string} pathTemplate
 * @returns {{parameterNames: string[], expression: RegExp}}
 */
function compilePath(pathTemplate) {
  const parameterNames = [];
  const pattern = pathTemplate.replace(/:([^/]+)/g, (_, name) => {
    parameterNames.push(name);
    return '([^/]+)';
  });

  return {
    parameterNames,
    expression: new RegExp(`^${pattern}/?$`)
  };
}

/**
 * Creates a first-match router for normalized Lambda HTTP requests.
 * The returned router resolves to `null` when it does not own the method/path.
 *
 * @param {Array<{method: string, path: string, handler: Function}>} routes
 * @returns {(request: object) => Promise<object|null>}
 */
function createRouter(routes) {
  const compiledRoutes = routes.map(route => ({
    ...route,
    ...compilePath(route.path)
  }));

  return async request => {
    for (const route of compiledRoutes) {
      if (route.method !== request.method) {
        continue;
      }

      const match = route.expression.exec(request.path);

      if (!match) {
        continue;
      }

      const matchedParameters = Object.fromEntries(
        route.parameterNames.map((name, index) => [
          name,
          decodeURIComponent(match[index + 1])
        ])
      );

      return route.handler({
        ...request,
        pathParameters: {
          ...matchedParameters,
          ...request.pathParameters
        }
      });
    }

    return null;
  };
}

module.exports = {
  compilePath,
  createRouter
};
