(function () {
    'use strict';

    var config = {
        // Domains to consider as first-party
        firstPartyWhitelist: ['kinja.com', 'kinja-img.com', 'kinja-static.com'],

        // Tags that should be added to files matching the specified regexes
        fileTags: {
            scriptLoader: /require\.js/i,
            mainScript: /javascripts\-min\/layer\/.*\.js$/i
        },

        itemHeight: 10,  // item height, in SVG coordinate units
        itemMargin: 2   // margin between items, in SVG coordinate units
    },
    chartContainer = document.querySelector('.chart');

    /**
     * Given array of request objects, return a regular expression of first-party requests
     * (FIXME: this is Kinja-specific - move out to config)
     * @param {array[object]} requests - array of request objects
     * @returns {RegExp} regex for identifying "first-party" requests
     */
    function getFirstPartyRegex(requests) {
        // Kinja-specific regex for identifying first-party requests
        config.firstPartyWhitelist.push(requests[0].domain);  // whitelist base page domain
        return new RegExp('(' + config.firstPartyWhitelist.join('|').replace(/\./g, '\\.') + ')$');
    }

    function toClassName(state) {
        // Replace camel-cased state name with hyphenated lowercase classname
        return state.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    }

    /**
     * Given an object containing HAR data, return an array of objects representing individual requests,
     * augmented with useful info like request start and end times.
     * @param {object} harData
     * @returns {array[object]} - array of objects with fields:
     *  - {string} url - request URL, abbreviated for display purposes
     *  - {string} domain - request domain, abbreviated for display purposes
     *  - {string} path - request path
     *  - {number} duration - request duration (ms)
     *  - {number} start - request start time (ms)
     *  - {number} end - request end time (ms)
     *  - {boolean} firstParty - whether request is a first-party request
     *  - {boolean} stats - whether request is a first-party stats-related request
     */
    function getRequestsFromHar(harData) {
        var harLog = harData.log,
            startDate = new Date(harLog.pages[0].startedDateTime),
            onLoad = harLog.pages[0].pageTimings.onLoad,
            items = [],
            firstPartyRegex;

        // No support for multi-page HAR files at moment -- filter entries to first page
        if (harLog.pages.length > 1) {
            harLog.entries = harLog.entries.filter(function (entry) {
                return entry.pageref === harLog.pages[0].id;
            });
        }

        function urlAbbreviate(url) {
            url = url.replace(/^https?:\/\/(www\.)?/i, '');  // remove leading protocol/www
            url = url.replace(/\?.*/g, '');  // remove querystring
            url = url.replace(/#.*/g, '');  // remove fragment identifier
            return url;
        }

        function mimeToFiletype(mimeType) {
            if (mimeType.indexOf('image') > -1) {
                return 'image';
            } else if (mimeType.indexOf('script') > -1) {
                return 'script';
            } else if (mimeType.indexOf('css') > -1) {
                return 'style';
            } else if (mimeType.indexOf('font') > -1) {
                return 'font';
            } else {
                return 'other';
            }
        }

        /**
         * Given a URL, return object whose keys represent identified filename-based tags,
         * and `true` as a value for all identified tags.
         */
        function getFileTags(url) {
            var tags = {};
    
            Object.keys(config.fileTags).forEach(function (tagName) {
                var regex = config.fileTags[tagName];
                if (url.match(regex)) {
                    tags[tagName] = true;
                }
            });

            return tags;
        }

        items = harLog.entries.map(function (entry) {
            var startTimeMs = new Date(entry.startedDateTime) - startDate,
                url = urlAbbreviate(entry.request.url);

            return {
                tags: getFileTags(url),
                type: mimeToFiletype(entry.response.content.mimeType || ''),
                originalUrl: entry.request.url,
                url: url,
                domain: url.substring(0, url.indexOf('/')),
                path: url.substring(url.indexOf('/')),
                start: startTimeMs,
                duration: entry.time,
                end: Math.round(startTimeMs + entry.time)
            };
        });

        // Ignore requests which arrived after onload event
        items = items.filter(function (item) {
            return (item.start <= onLoad);
        });

        console.log(items.length, 'total requests');

        // And augment with some Kinja page-specific info (FIXME: move out for reusability)
        firstPartyRegex = getFirstPartyRegex(items);
        items = items.map(function (entry) {

            // Mark first-party requests as such
            entry.firstParty = Boolean(entry.domain.match(firstPartyRegex));

            // Mark internal stats requests as such
            entry.stats = (entry.firstParty && entry.path.indexOf('/stats/') === 0);

            return entry;
        });

        return items;
    }

    /**
     * Given an array matching currently-displayed request data, zoom
     * our chart to the smallest bounding box of elements matching
     * the specified filter function.
     * @param {d3.Selection} selection - D3 element selection
     * @param {function} [filter] - function to use for filtering to elements
     *                             that should be zoomed.
     * @param {number} [margin] - optional margin to leave around the zoomed area (as value from 0-1)
     */
    function zoomToElements(selection, filter, margin) {
        var data = selection.data(),
            filtered, filteredMax, max;

        margin = margin || 0;

        // If no filter specified, zoom out
        filter = filter || function () {
            return true;
        };

        // Store original index of each item (so we know its position when filtered)
        data.forEach(function (d, idx) {
            d.index = idx;
        });

        filtered = data.filter(filter);
        filteredMax = {};
        max = {};

        // FIXME: d3.scale could likely be used here...
        function getXCoordinate(d) {
            return d.end;
        }

        function getYCoordinate(d) {
            return d.index * (config.itemHeight + config.itemMargin);
        }

        filteredMax.x = Math.max.apply(null, filtered.map(getXCoordinate));
        filteredMax.y = Math.max.apply(null, filtered.map(getYCoordinate));

        max.x = Math.max.apply(null, data.map(getXCoordinate));
        max.y = Math.max.apply(null, data.map(getYCoordinate));

        // Add some margin to zoomed area
        if (filteredMax.x < max.x) {
            filteredMax.x = Math.min(filteredMax.x * (1 + margin), max.x);
        }
        if (filteredMax.y < max.y) {
            filteredMax.y = Math.min(filteredMax.y * (1 + margin), max.y);
        }

        document.getElementsByTagName('svg')[0].style.transform = '' +
            'scaleX(' + (max.x / filteredMax.x) + ') ' +
            'scaleY(' + (max.y / filteredMax.y) + ')';
			// still rather blurry for me in Chrome...
            //'scale3d(' + (max.x / filteredMax.x) + ', ' + (max.y / filteredMax.y) + ', 1.0)';
    }

    d3.json('chart-data/gawker.com.wpt.har.json', function (error, data) {

        var last, totalHeight, svg, div, bars, tooltip;

        data = getRequestsFromHar(data);

        last = data[data.length - 1];
        totalHeight = (config.itemHeight + config.itemMargin) * data.length;

        svg = d3.select('.chart').append('svg')
            .attr('viewBox', '0 0 ' + last.end + ' ' + totalHeight)
            .attr('preserveAspectRatio', 'none');

        tooltip = d3.select('.chart').append('div')
            .style('opacity', 0)
            .attr('class', 'tooltip');

        bars = svg.selectAll('rect')
            .data(data)
            .enter().append('rect')
            .attr('id', function (d, i) {
                return 'chartEntry' + i;
            })
            .attr('x', function (d) {
                return d.start;
            })
            .attr('y', function (d, i) {
                return i * (config.itemHeight + config.itemMargin);
            })
            .attr('width', function (d) {
                return d.duration;
            })
            .attr('height', function (d) {
                return config.itemHeight;
            })
            .attr('title', function (d) {
                return d.domain + d.path;
            })
            .each(function (d) {
                this.classList.add('filetype-' + d.type);
                this.classList.add(d.firstParty ? 'firstparty' : 'thirdparty');

                Object.keys(d.tags).forEach(function (tagName) {
                    this.classList.add('tag-' + toClassName(tagName));
                }.bind(this));
            })
            .on('mouseover', function (d) {
                window.postMessage(JSON.stringify({
                    namespace: 'reveal-chart',
                    eventName: 'showTooltip',
                    itemData: d,
                    selection: this,
                    id: this.id
                }), '*');
            })
            .on('mouseout', function (d) {
                window.postMessage(JSON.stringify({
                    namespace: 'reveal-chart',
                    eventName: 'hideTooltip',
                    itemData: d,
                    id: this.id
                }), '*');
            });

        function msToRoundedS(ms) {
            var seconds = ms / 1000;
            return (Math.round(seconds * 100) / 100) + 's';
        }

        // Handle tooltip display
        window.addEventListener('message', function showTooltip(event) {
            var data = JSON.parse(event.data),
                itemData,
                itemEl;

            if (window.parent && window.parent !== window) {
                window.parent.postMessage(event.data, '*');
            }

            if (data && data.namespace === 'reveal-chart') {
                itemData = data.itemData;
                itemEl = document.getElementById(data.id);

                if (data.eventName === 'showTooltip') {
                    itemEl.classList.add('selected');
                    tooltip
                        .html('<p>' + itemData.url + '</p>' +
                            '<p>' +
                                'Start: ' + msToRoundedS(itemData.start) + ' / ' +
                                'End: ' + msToRoundedS(itemData.end) +
                                ' (' + msToRoundedS(itemData.duration) + ')' +
                            '</p>'
                        )
                        .style('opacity', 1);
                    Reveal.getCurrentSlide().classList.add('tooltip-open');

                } else if (data.eventName === 'hideTooltip') {
                    itemEl.classList.remove('selected');

                    tooltip
                        .html('')
                        .style('opacity', 0);

                    Reveal.getCurrentSlide().classList.remove('tooltip-open');
                }

            }
        });


        /**
         * Add an event listener that unregisters itself after being called once.
         * @param {string} event - event name
         * @param {function} handler - event handler
         */
        function listenOnce(event, handler) {
            var wrappedHandler = function () {
                Reveal.removeEventListener(event, wrappedHandler);
                handler(event);
            };
            Reveal.addEventListener(event, wrappedHandler, false);
        }

        // Registry of state transitions to handle. Used in place of
        //  Reveal.addEventListener(STATE_NAME); in order to have control
        //  over ordering of state change event firings for in/out
        //  transitions.
        var stateTransitions = {
            in: {},
            out: {}
        };

        /**
         * Registers handlers for transitioning between slides that affect chart state.
         * Used in place of Reveal.addEventListener(STATE_NAME) to ensure that we can
         * fire changes in proper order (transition previous slide out first).
         *
         * @param {string} state - name of state change to listen to event for (will be prefixed with 'chart.')
         * @param {function} [transitionIn] - handler for transitioning to state
         * @param {function} [transitionOut] - handler for transitioning from state
         */
        function registerStateChange(state, transitionIn, transitionOut) {
            stateTransitions.in[state] = transitionIn || function () {};
            stateTransitions.out[state] = transitionOut || function () {};
        }

        function handleStateChange(previousState, currentState) {
            if (currentState === previousState) {
                return;
            }

            if (previousState) {
                if (currentState && stateTransitions.out[previousState]) {
                    stateTransitions.out[previousState]();
                }
                svg.classed(toClassName(previousState), false);
            }

            if (currentState) {
                if (stateTransitions.in[currentState]) {
                    stateTransitions.in[currentState]();
                }
                svg.classed(toClassName(currentState), true);
            }
        }

        // Listen to slidechanged, rather than state changes, to work
        //  around event ordering issues.
        Reveal.addEventListener('slidechanged', function onSlideChanged(e) {
            handleStateChange(e.previousSlide.dataset.state, e.currentSlide.dataset.state);

            e.currentSlide.classList.remove('tooltip-open');  // remove any stray open-tooltip styling
        });

        /**
         * To use the same D3 chart in multiple slide stacks we swap it and a
         * placeholder if necessary.
         */
        function moveChartIfNeeded(currentSlide) {
            var topSlide = currentSlide,
                parentNode = topSlide.parentNode,
                chartPlaceholder;

            if (parentNode.tagName.toLowerCase() === 'section') {
                topSlide = parentNode;
            }

            chartPlaceholder = topSlide.querySelector('.chart-placeholder');
            if (chartPlaceholder) {
                // Replace placeholder with chart and chart with placeholder
                chartContainer.parentNode.insertBefore(chartPlaceholder.cloneNode(), chartContainer);
                chartPlaceholder.parentNode.insertBefore(chartContainer, chartPlaceholder);
                chartPlaceholder.parentNode.removeChild(chartPlaceholder);
            }
        }

        // See if we need to move the SVG chart over to the new slide
        Reveal.addEventListener('slidechanged', function onSlideChangedMoveSVG(e) {
            moveChartIfNeeded(e.currentSlide);
        });

        function resetZoom() {
            zoomToElements(bars);
        }

        registerStateChange('chartInitial', resetZoom);

        registerStateChange('chartHighlightScripts',
            function () {
                zoomToElements(bars, function (item) {
                    return (item.type === 'script');
                });
            },
            resetZoom);

        registerStateChange('chartZoomFirstparty',
            function () {
                zoomToElements(bars, function (item) {
                    return (item.firstParty && !item.stats);
                });
            }, resetZoom);

        registerStateChange('chartZoomFirstpartyImages',
            function () {
                zoomToElements(bars, function (item) {
                    return (item.firstParty && !item.stats && item.type === 'image');
                }, 0.1);
            }, resetZoom);

        registerStateChange('chartZoomFirstpartyIgnoreImages',
            function () {
                zoomToElements(bars, function (item) {
                    return (item.firstParty && !item.stats && item.type !== 'image');
                }, 0.1);
            }, resetZoom);

        registerStateChange('chartZoomMainScripts',
            function () {
                zoomToElements(bars, function (item) {
                    return Boolean(item.tags.mainScript);
                }, 0.1);
            }, resetZoom);

        moveChartIfNeeded(Reveal.getCurrentSlide());

        // Set an initial zoom on chart so we get a zoom-out effect when displaying it
        zoomToElements(bars, function (item) {
            return (item.firstParty && !item.stats && item.type !== 'image');
        }, 0.1);

        // Handle initial transition-in if we started on a slide with a state
        handleStateChange(null, Reveal.getCurrentSlide().dataset.state);
    });
}());
