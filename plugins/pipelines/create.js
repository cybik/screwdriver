'use strict';

const boom = require('boom');
const schema = require('screwdriver-data-schema');
const urlLib = require('url');

const MATCH_COMPONENT_BRANCH_NAME = 4;
/**
 * Format the scm url to include a branch and make case insensitive
 * @method formatCheckoutUrl
 * @param  {String}     checkoutUrl     Checkout url (ex: git@github.com:screwdriver-cd/screwdriver.git#branchName)
 *                                      or (ex: https://github.com/screwdriver-cd/screwdriver.git#branchName)
 * @return {String}                     Lowercase scm url with branch name
 */
const formatCheckoutUrl = (checkoutUrl) => {
    let result = checkoutUrl;
    const matched = (schema.config.regex.CHECKOUT_URL).exec(result);
    let branchName = matched[MATCH_COMPONENT_BRANCH_NAME];

    // Check if branch name exists
    if (!branchName) {
        branchName = '#master';
    }

    // Do not convert branch name to lowercase
    result = result.split('#')[0].toLowerCase().concat(branchName);

    return result;
};

module.exports = () => ({
    method: 'POST',
    path: '/pipelines',
    config: {
        description: 'Create a new pipeline',
        notes: 'Create a specific pipeline',
        tags: ['api', 'pipelines'],
        auth: {
            strategies: ['token', 'session'],
            scope: ['user']
        },
        plugins: {
            'hapi-swagger': {
                security: [{ token: [] }]
            }
        },
        handler: (request, reply) => {
            const checkoutUrl = formatCheckoutUrl(request.payload.checkoutUrl);
            const pipelineFactory = request.server.app.pipelineFactory;
            const userFactory = request.server.app.userFactory;
            const username = request.auth.credentials.username;

            // fetch the user
            return userFactory.get({ username })
                .then(user => user.unsealToken()
                    .then(token => pipelineFactory.scm.parseUrl({
                        checkoutUrl,
                        token
                    }))
                    // get the user permissions for the repo
                    .then(scmUri => user.getPermissions(scmUri)
                        // if the user isn't an admin, reject
                        .then((permissions) => {
                            if (!permissions.admin) {
                                throw boom.unauthorized(
                                  `User ${username} is not an admin of this repo`);
                            }
                        })
                        // see if there is already a pipeline
                        .then(() => pipelineFactory.get({ scmUri }))
                        // if there is already a pipeline for the checkoutUrl, reject
                        .then((pipeline) => {
                            if (pipeline) {
                                throw boom.conflict(`Pipeline already exists: ${pipeline.id}`);
                            }
                        })
                        // set up pipeline admins, and create a new pipeline
                        .then(() => {
                            const pipelineConfig = {
                                admins: {
                                    [username]: true
                                },
                                scmUri
                            };

                            return pipelineFactory.create(pipelineConfig);
                        })))
                // hooray, a pipeline is born!
                .then(pipeline =>
                    // sync pipeline to create jobs
                    pipeline.sync()
                        // return pipeline info to requester
                        .then(() => {
                            const location = urlLib.format({
                                host: request.headers.host,
                                port: request.headers.port,
                                protocol: request.server.info.protocol,
                                pathname: `${request.path}/${pipeline.id}`
                            });

                            return reply(pipeline.toJson()).header('Location', location).code(201);
                        })
                )
                // something broke, respond with error
                .catch(err => reply(boom.wrap(err)));
        },
        validate: {
            payload: schema.models.pipeline.create
        }
    }
});
