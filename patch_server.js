        const col = {
            day:        headers.findIndex(h => /^ngày$|^day$/i.test(h)),
            month:      headers.findIndex(h => /^tháng$|^month$/i.test(h)),
            year:       headers.findIndex(h => /^năm$|^year$/i.test(h)),
            date:       headers.findIndex(h => /ngày|date/.test(h)),
            type:       headers.findIndex(h => /^loại|^type/.test(h)),
